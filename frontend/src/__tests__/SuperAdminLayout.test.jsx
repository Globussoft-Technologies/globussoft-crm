import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import SuperAdminLayout from "../pages/superadmin/SuperAdminLayout";

const superAdminStyles = readFileSync(
  resolve(process.cwd(), "src/pages/superadmin/super-admin.css"),
  "utf8",
);

vi.mock("../utils/superAdminApi", () => ({
  getSuperAdminToken: vi.fn(() => "test-token"),
  getSuperAdminUsername: vi.fn(() => "superadmin"),
  clearSuperAdminSession: vi.fn(),
  superAdminFetch: vi.fn(),
}));

function renderSuperAdminLayout(initialEntry = "/super-admin/page-visibility") {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <Routes>
        <Route path="/super-admin" element={<SuperAdminLayout />}>
          <Route path="page-visibility" element={<div>Page visibility content</div>} />
          <Route path="cron" element={<div>Cron page content</div>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  localStorage.clear();
});

describe("SuperAdminLayout responsive navigation", () => {
  test("opens the mobile navigation and closes it with Escape", () => {
    const { container } = renderSuperAdminLayout();
    const menuToggle = screen.getByRole("button", { name: "Open navigation menu" });

    fireEvent.click(menuToggle);

    expect(menuToggle).toHaveAttribute("aria-expanded", "true");
    expect(container.querySelector("#super-admin-navigation")).toHaveClass("is-open");

    fireEvent.keyDown(window, { key: "Escape" });

    expect(screen.getByRole("button", { name: "Open navigation menu" })).toHaveAttribute("aria-expanded", "false");
    expect(container.querySelector("#super-admin-navigation")).not.toHaveClass("is-open");
  });

  test("closes the mobile navigation after selecting a page or tapping outside it", async () => {
    const { container } = renderSuperAdminLayout();
    fireEvent.click(screen.getByRole("button", { name: "Open navigation menu" }));
    fireEvent.click(screen.getByRole("link", { name: "Cron Maintenance" }));

    expect(await screen.findByText("Cron page content")).toBeInTheDocument();
    expect(container.querySelector("#super-admin-navigation")).not.toHaveClass("is-open");

    fireEvent.click(screen.getByRole("button", { name: "Open navigation menu" }));
    fireEvent.click(container.querySelector(".super-admin-mobile-backdrop"));

    expect(screen.getByRole("button", { name: "Open navigation menu" })).toHaveAttribute("aria-expanded", "false");
    expect(container.querySelector("#super-admin-navigation")).not.toHaveClass("is-open");
  });

  test("defines the compact mobile header, drawer, and full-width content breakpoint", () => {
    expect(superAdminStyles).toContain("@media (max-width: 900px)");
    expect(superAdminStyles).toContain("width: min(84vw, 300px);");
    expect(superAdminStyles).toContain(".super-admin-sidebar.is-open");
    expect(superAdminStyles).toContain(".super-admin-main > *");
    expect(superAdminStyles).toContain("grid-template-columns: minmax(0, 1fr);");
  });
});
