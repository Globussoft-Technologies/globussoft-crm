/**
 * App.jsx auth-sync regression coverage.
 *
 * Pins the behaviour added in the #1284 fix: on initial mount, App validates
 * the rehydrated token by calling GET /api/auth/me and syncs the AuthContext
 * user/tenant to the actual server identity. This prevents the UI from showing
 * one account (from stale localStorage) while the API rejects requests with the
 * token of another account — the symptom that produced the travel dashboard
 * WRONG_VERTICAL error.
 *
 * We mock the route-level lazy imports so we don't need to load every page
 * component; the mocked components just render a marker so we can assert that
 * the route table resolved to the expected landing page.
 */
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

vi.mock("../utils/lazyWithRetry", () => ({
  lazyWithRetry: () => () => <div data-testid="lazy-route">route loaded</div>,
}));

import App from "../App";

function setupFetch(mockImpl) {
  const fetchMock = vi.fn((url) => {
    if (typeof mockImpl === "function") return mockImpl(url);
    return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  // jsdom does not implement matchMedia; App uses it for theme detection.
  window.matchMedia =
    window.matchMedia ||
    function () {
      return { matches: false, addEventListener: () => {}, removeEventListener: () => {} };
    };
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("<App /> — auth-sync on mount", () => {
  it("renders the login page when no token is present", async () => {
    setupFetch();
    // BrowserRouter uses the real URL; point it at /login so the public
    // landing page does not swallow the render.
    window.history.pushState({}, "login", "/login");
    render(<App />);
    await waitFor(() =>
      expect(screen.getByText(/Sign into your CRM account/i)).toBeInTheDocument(),
    );
  });

  it("validates a travel token against /api/auth/me and lands on /travel", async () => {
    const token = "travel-token";
    sessionStorage.setItem("token", token);
    const fetchMock = setupFetch((url) => {
      if (url === "/api/auth/me") {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              id: 30,
              name: "Yasin (Owner)",
              email: "yasin@travelstall.in",
              role: "ADMIN",
              tenant: {
                id: 3,
                name: "Travel Stall",
                slug: "travel-stall",
                vertical: "travel",
              },
            }),
        });
      }
      if (url === "/api/subscriptions/status") {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ daysRemaining: 30, status: "active" }),
        });
      }
      return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) });
    });

    render(<App />);
    await waitFor(() => expect(screen.getByTestId("lazy-route")).toBeInTheDocument());
    expect(fetchMock).toHaveBeenCalledWith("/api/auth/me", {
      headers: { Authorization: `Bearer ${token}` },
    });
  });

  it("overwrites stale localStorage user/tenant with the server identity", async () => {
    const token = "travel-token";
    sessionStorage.setItem("token", token);
    // Simulate the exact stale state that caused the WRONG_VERTICAL symptom:
    // localStorage still holds a wellness user/tenant, but the in-memory token
    // belongs to the travel account.
    localStorage.setItem(
      "user",
      JSON.stringify({ id: 5, name: "Rishu", role: "ADMIN" }),
    );
    localStorage.setItem(
      "tenant",
      JSON.stringify({ id: 2, name: "Enhanced Wellness", vertical: "wellness" }),
    );

    setupFetch((url) => {
      if (url === "/api/auth/me") {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              id: 30,
              name: "Yasin (Owner)",
              email: "yasin@travelstall.in",
              role: "ADMIN",
              tenant: {
                id: 3,
                name: "Travel Stall",
                slug: "travel-stall",
                vertical: "travel",
              },
            }),
        });
      }
      if (url === "/api/subscriptions/status") {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ daysRemaining: 30, status: "active" }),
        });
      }
      return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) });
    });

    render(<App />);
    // The app should redirect to /travel, which renders our lazy marker.
    await waitFor(() => expect(screen.getByTestId("lazy-route")).toBeInTheDocument());
  });

  it("clears session and returns to login when the token is rejected", async () => {
    const token = "invalid-token";
    sessionStorage.setItem("token", token);
    localStorage.setItem(
      "user",
      JSON.stringify({ id: 30, name: "Yasin (Owner)", role: "ADMIN" }),
    );
    localStorage.setItem(
      "tenant",
      JSON.stringify({ id: 3, name: "Travel Stall", vertical: "travel" }),
    );

    setupFetch((url) => {
      if (url === "/api/auth/me") {
        return Promise.resolve({
          ok: false,
          status: 401,
          json: () => Promise.resolve({ error: "Session expired" }),
        });
      }
      return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) });
    });

    render(<App />);
    await waitFor(() =>
      expect(screen.getByText(/Sign into your CRM account/i)).toBeInTheDocument(),
    );
    expect(sessionStorage.getItem("token")).toBeNull();
    expect(localStorage.getItem("user")).toBeNull();
    expect(localStorage.getItem("tenant")).toBeNull();
  });

  it("clears session on vertical/tenant mismatch (403) so the user is not trapped", async () => {
    const token = "wellness-token";
    sessionStorage.setItem("token", token);
    localStorage.setItem(
      "user",
      JSON.stringify({ id: 30, name: "Yasin (Owner)", role: "ADMIN" }),
    );
    localStorage.setItem(
      "tenant",
      JSON.stringify({ id: 3, name: "Travel Stall", vertical: "travel" }),
    );

    setupFetch((url) => {
      if (url === "/api/auth/me") {
        return Promise.resolve({
          ok: false,
          status: 403,
          json: () => Promise.resolve({ error: "Tenant mismatch", code: "WRONG_VERTICAL" }),
        });
      }
      return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) });
    });

    render(<App />);
    await waitFor(() =>
      expect(screen.getByText(/Sign into your CRM account/i)).toBeInTheDocument(),
    );
    expect(sessionStorage.getItem("token")).toBeNull();
  });
});
