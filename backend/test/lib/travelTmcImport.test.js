const {
  PARTICIPANT_IMPORT_HEADERS,
  buildParticipantImportTemplate,
  missingParticipantImportHeaders,
  parseSpreadsheetBuffer,
  parseParticipantImportRow,
} = require("../../lib/travelTmcImport");

describe("TMC participant import template", () => {
  test.each(["csv", "xlsx"])("%s template has importable headers and required contact fields", (format) => {
    const file = { originalname: `participants.${format}` };
    const template = buildParticipantImportTemplate(format);
    const parsed = parseSpreadsheetBuffer(
      format === "csv" ? Buffer.from(template) : template,
      file,
    );

    expect(parsed.headers).toEqual(PARTICIPANT_IMPORT_HEADERS);
    expect(parsed.rows).toEqual([]);
    expect(missingParticipantImportHeaders(parsed.headers)).toEqual([]);
  });

  test("XLSX includes instructions after the importable Participants sheet", () => {
    const workbook = require("xlsx").read(buildParticipantImportTemplate("xlsx"), { type: "buffer" });
    expect(workbook.SheetNames).toEqual(["Participants", "Instructions"]);
    const guide = require("xlsx").utils.sheet_to_json(workbook.Sheets.Instructions);
    expect(guide.filter((row) => row.Required === "Yes").map((row) => row.Column))
      .toEqual(["fullName", "parentName", "parentPhone", "parentEmail"]);
  });

  test("requires all four contact values and validates their formats", () => {
    const missing = parseParticipantImportRow({ fullName: "Anaya" }, 2);
    expect(missing.errors.map((error) => error.reason)).toEqual([
      "parentName is required", "parentEmail is required", "parentPhone is required",
    ]);

    const invalid = parseParticipantImportRow({
      fullName: "Anaya", parentName: "Riya", parentPhone: "abc", parentEmail: "not-an-email",
    }, 3);
    expect(invalid.errors.map((error) => error.reason)).toContain("invalid parentPhone");
    expect(invalid.errors.map((error) => error.reason)).toContain("invalid parentEmail");

    const valid = parseParticipantImportRow({
      fullName: "Anaya", parentName: "Riya", parentPhone: "9876543210", parentEmail: "RIYA@example.com",
    }, 4);
    expect(valid.errors).toEqual([]);
    expect(valid.data).toMatchObject({ parentPhone: "+919876543210", parentEmail: "riya@example.com" });
  });
});
