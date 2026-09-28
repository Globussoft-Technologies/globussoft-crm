import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import TallyCompanySetupPage from "./TallyCompanySetupPage";

const { navigate, saveMaster, cancelEdit, updateMaster, updateAccountNumber } = vi.hoisted(() => ({
  navigate: vi.fn(),
  saveMaster: vi.fn(),
  cancelEdit: vi.fn(),
  updateMaster: vi.fn(),
  updateAccountNumber: vi.fn(),
}));

vi.mock("react-router-dom", () => ({ useNavigate: () => navigate }));
vi.mock("./TallySectionNav", () => ({
  default: () => <nav>Tally navigation</nav>,
  TallyWriteGate: ({ children }) => children,
}));
vi.mock("./useTravelTallyMaster", () => ({
  useTravelTallyMaster: () => ({
    master: {
      companyName: "Travel Test",
      mailingName: "",
      gstin: "",
      pan: "",
      state: "Karnataka",
      address: "",
      country: "India",
      pinCode: "",
      contactNumber: "",
      email: "",
      financialYear: "2026-2027",
      financialYearTo: "31-03-2027",
      booksBeginningFrom: "2026-04-01",
      voucherNumbering: "auto",
      baseCurrency: "INR",
      openingBalanceMode: "adjusted",
      bankDetails: {
        bankName: "",
        accountName: "",
        accountNumber: "",
        ifscCode: "",
        branchName: "",
        upiId: "",
      },
    },
    updateMaster,
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
    updateMaster.mockImplementation((key) =>
      key === "bankDetails.accountNumber" ? updateAccountNumber : vi.fn(),
    );
  });

  it("lets a read-only configured user continue without writing settings", async () => {
    render(<TallyCompanySetupPage />);
    await waitFor(() => expect(screen.getByText("Master details").closest("fieldset")).toBeDisabled());

    fireEvent.click(screen.getByRole("button", { name: "Continue to Ledgers" }));

    expect(saveMaster).not.toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith("/travel/tally/ledger");
  });

  it("keeps the bank account number numeric and preserves leading zeroes", async () => {
    render(<TallyCompanySetupPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit Company Setup" }));

    const accountNumber = screen.getByLabelText("Account number");
    fireEvent.change(accountNumber, { target: { value: "00AB1234567890123456789" } });

    expect(accountNumber).toHaveAttribute("inputmode", "numeric");
    expect(accountNumber).toHaveAttribute("maxlength", "18");
    expect(updateAccountNumber).toHaveBeenCalledWith("001234567890123456");
  });
});
