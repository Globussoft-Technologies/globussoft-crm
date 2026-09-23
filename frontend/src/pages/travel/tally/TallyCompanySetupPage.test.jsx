import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import TallyCompanySetupPage from "./TallyCompanySetupPage";

const { navigate, saveMaster, cancelEdit } = vi.hoisted(() => ({
  navigate: vi.fn(),
  saveMaster: vi.fn(),
  cancelEdit: vi.fn(),
}));

vi.mock("react-router-dom", () => ({ useNavigate: () => navigate }));
vi.mock("./TallyMasterSection", () => ({ default: () => <div>Company fields</div> }));
vi.mock("./TallySectionNav", () => ({
  default: () => <nav>Tally navigation</nav>,
  TallyWriteGate: ({ children }) => children,
}));
vi.mock("./useTravelTallyMaster", () => ({
  useTravelTallyMaster: () => ({
    master: { companyName: "Travel Test" },
    updateMaster: vi.fn(),
    validateMasterStep: vi.fn(() => ""),
    saveMaster,
    cancelEdit,
    isConfigured: true,
    masterHydrated: true,
  }),
}));

describe("TallyCompanySetupPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    saveMaster.mockResolvedValue({});
  });

  it("lets a read-only configured user continue without writing settings", async () => {
    render(<TallyCompanySetupPage />);
    await waitFor(() => expect(screen.getByText("Company fields").closest("fieldset")).toBeDisabled());

    fireEvent.click(screen.getByRole("button", { name: "Continue to Ledgers" }));

    expect(saveMaster).not.toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith("/travel/tally/ledger");
  });
});
