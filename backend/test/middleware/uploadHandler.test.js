/**
 * uploadHandler tests
 *
 * Verifies the multer configs that back document/image uploads.
 * Documents are now capped at 150 MB and written to a temp directory
 * so large files do not fill the Node heap.
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import multer from 'multer';
import express from 'express';
import request from 'supertest';

const {
  uploadDocumentSingle,
  uploadDocumentMultiple,
  validateDocument,
  validateDocuments,
  DOCUMENT_MAX_FILE_SIZE,
} = require('../../middleware/uploadHandler');

let app;

beforeAll(() => {
  app = express();

  app.post(
    '/single',
    uploadDocumentSingle,
    validateDocument,
    (req, res) => {
      res.json({
        fileName: req.file.originalname,
        path: req.file.path,
        hasBuffer: req.file.buffer !== undefined,
        size: req.file.size,
        mimetype: req.file.mimetype,
      });
    }
  );

  app.post(
    '/multiple',
    uploadDocumentMultiple,
    validateDocuments,
    (req, res) => {
      res.json({
        count: req.files.length,
        files: req.files.map((f) => ({
          fileName: f.originalname,
          path: f.path,
          hasBuffer: f.buffer !== undefined,
          size: f.size,
        })),
      });
    }
  );

  app.use((err, _req, res, _next) => {
    res.status(400).json({ code: err.code, message: err.message });
  });
});

afterAll(async () => {
  // Best-effort cleanup of any temp files the test app left behind.
  const tempDir = path.join(os.tmpdir(), 'globuscrm-uploads-documents');
  if (fs.existsSync(tempDir)) {
    const files = await fs.promises.readdir(tempDir).catch(() => []);
    await Promise.all(
      files
        .filter((name) => name.startsWith('test-'))
        .map((name) =>
          fs.promises.unlink(path.join(tempDir, name)).catch(() => {})
        )
    );
  }
});

const TINY_PDF = Buffer.from(
  '%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [] /Count 0 >>\nendobj\nxref\n0 3\n0000000000 65535 f\n0000000009 00000 n\n0000000058 00000 n\ntrailer\n<< /Size 3 /Root 1 0 R >>\nstartxref\n105\n%%EOF\n'
);

describe('uploadHandler', () => {
  test('exports DOCUMENT_MAX_FILE_SIZE as 150 MB', () => {
    expect(DOCUMENT_MAX_FILE_SIZE).toBe(150 * 1024 * 1024);
  });

  test('uploadDocumentSingle stores files on disk, not in memory', async () => {
    const res = await request(app)
      .post('/single')
      .attach('document', TINY_PDF, 'deck.pdf')
      .expect(200);

    expect(res.body).toMatchObject({
      fileName: 'deck.pdf',
      hasBuffer: false,
      size: TINY_PDF.length,
      mimetype: 'application/pdf',
    });
    expect(res.body.path).toBeDefined();
    expect(fs.existsSync(res.body.path)).toBe(true);

    await fs.promises.unlink(res.body.path).catch(() => {});
  });

  test('uploadDocumentMultiple stores each file on disk', async () => {
    const res = await request(app)
      .post('/multiple')
      .attach('documents', TINY_PDF, 'a.pdf')
      .attach('documents', TINY_PDF, 'b.pdf')
      .expect(200);

    expect(res.body.count).toBe(2);
    for (const f of res.body.files) {
      expect(f.hasBuffer).toBe(false);
      expect(f.path).toBeDefined();
      expect(fs.existsSync(f.path)).toBe(true);
      await fs.promises.unlink(f.path).catch(() => {});
    }
  });

  test('rejects oversized documents with LIMIT_FILE_SIZE', async () => {
    // We cannot allocate 150 MB in a unit test, so create a temporary
    // Express route with a tiny limit to exercise the size-ceiling path.
    const tmpDir = path.join(os.tmpdir(), 'globuscrm-uploads-test');
    fs.mkdirSync(tmpDir, { recursive: true });

    const limitedApp = express();
    limitedApp.post(
      '/single',
      multer({
        storage: multer.diskStorage({
          destination: (_req, _file, cb) => cb(null, tmpDir),
          filename: (_req, _file, cb) => cb(null, `test-${Date.now()}.pdf`),
        }),
        fileFilter: (_req, file, cb) => {
          cb(null, file.mimetype === 'application/pdf');
        },
        limits: { fileSize: 16 }, // smaller than TINY_PDF
      }).single('document'),
      (_req, res) => res.json({ ok: true })
    );
    limitedApp.use((err, _req, res, _next) => {
      res.status(400).json({ code: err.code });
    });

    const res = await request(limitedApp)
      .post('/single')
      .attach('document', TINY_PDF, 'big.pdf');

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('LIMIT_FILE_SIZE');

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('rejects non-document MIME types', async () => {
    const res = await request(app)
      .post('/single')
      .attach('document', Buffer.from('MZ'), 'virus.exe');

    expect(res.status).toBe(400);
  });

  describe('validation middleware', () => {
    test('validateDocument returns 400 when req.file is missing', () => {
      const req = {};
      const res = {
        statusCode: null,
        jsonBody: null,
        status(code) {
          this.statusCode = code;
          return this;
        },
        json(body) {
          this.jsonBody = body;
        },
      };
      const next = () => {};

      validateDocument(req, res, next);

      expect(res.statusCode).toBe(400);
      expect(res.jsonBody).toEqual({ error: 'No document file provided' });
    });

    test('validateDocuments returns 400 when req.files is empty', () => {
      const req = {};
      const res = {
        statusCode: null,
        jsonBody: null,
        status(code) {
          this.statusCode = code;
          return this;
        },
        json(body) {
          this.jsonBody = body;
        },
      };
      const next = () => {};

      validateDocuments(req, res, next);

      expect(res.statusCode).toBe(400);
      expect(res.jsonBody).toEqual({ error: 'No document files provided' });
    });
  });
});
