import {
  baseCurrencyOptions,
  openingBalanceModeOptions,
  voucherNumberingOptions,
} from "./travelTallyMasterConfig";

const input = {
  padding: "10px 11px",
  borderRadius: 8,
  border: "1px solid var(--border-color, #334155)",
  background: "var(--input-bg, transparent)",
  color: "var(--text-primary)",
  width: "100%",
  boxSizing: "border-box",
};

const label = {
  display: "grid",
  gap: 6,
  fontSize: 13,
  color: "var(--text-secondary)",
};

function Field({
  title,
  value,
  onChange,
  placeholder,
  type = "text",
  required = false,
}) {
  return (
    <label style={label}>
      {title}
      {required ? " *" : ""}
      <input
        type={type}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        style={input}
      />
    </label>
  );
}

function SelectField({ title, value, onChange, options, required = false }) {
  return (
    <label style={label}>
      {title}
      {required ? " *" : ""}
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        style={input}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

export default function TallyMasterSection({
  master,
  updateMaster,
}) {
  return (
    <>
      <h2 style={{ margin: 0, fontSize: "1.15rem" }}>Master details</h2>
      <p style={{ color: "var(--text-secondary)", fontSize: 13 }}>
        Set up the company and accounting details first.
      </p>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))",
          gap: 14,
        }}
      >
        <Field
          title="Company name"
          value={master.companyName}
          onChange={updateMaster("companyName")}
          placeholder="Legal company name"
          required
        />
        <Field
          title="Mailing name"
          value={master.mailingName}
          onChange={updateMaster("mailingName")}
          placeholder="Name shown on invoices"
        />
        <Field
          title="GSTIN"
          value={master.gstin}
          onChange={updateMaster("gstin")}
          placeholder="22AAAAA0000A1Z5"
        />
        <Field
          title="PAN"
          value={master.pan}
          onChange={updateMaster("pan")}
          placeholder="AAAAA0000A"
        />
        <Field
          title="State"
          value={master.state}
          onChange={updateMaster("state")}
          placeholder="State / province"
          required
        />
        <Field title="Country" value={master.country} onChange={updateMaster("country")} placeholder="India" required />
        <Field title="PIN code" value={master.pinCode} onChange={updateMaster("pinCode")} placeholder="560001" />
        <Field title="Contact number" value={master.contactNumber} onChange={updateMaster("contactNumber")} placeholder="Contact number" />
        <Field title="Email" value={master.email} onChange={updateMaster("email")} placeholder="accounts@example.com" type="email" />
        <Field
          title="Financial year"
          value={master.financialYear}
          onChange={updateMaster("financialYear")}
          placeholder="2026-2027"
          required
        />
        <Field title="Financial year to" value={master.financialYearTo} onChange={updateMaster("financialYearTo")} placeholder="31-03-2027" required />
        <label style={label}>
          Books beginning from *
          <input
            type="date"
            value={master.booksBeginningFrom}
            onChange={(event) =>
              updateMaster("booksBeginningFrom")(event.target.value)
            }
            style={input}
          />
        </label>
        <SelectField
          title="Voucher numbering"
          value={master.voucherNumbering}
          onChange={updateMaster("voucherNumbering")}
          options={voucherNumberingOptions}
        />
        <SelectField
          title="Base currency"
          value={master.baseCurrency}
          onChange={updateMaster("baseCurrency")}
          options={baseCurrencyOptions}
        />
        <SelectField
          title="Opening balance handling"
          value={master.openingBalanceMode}
          onChange={updateMaster("openingBalanceMode")}
          options={openingBalanceModeOptions}
        />
        <label style={{ ...label, gridColumn: "span 2" }}>
          Registered address
          <textarea
            value={master.address}
            onChange={(event) => updateMaster("address")(event.target.value)}
            rows={2}
            placeholder="Business address"
            style={{ ...input, resize: "vertical" }}
          />
        </label>
        <Field title="Bank name" value={master.bankDetails?.bankName || ""} onChange={updateMaster("bankDetails.bankName")} placeholder="Bank name" />
        <Field title="Account name" value={master.bankDetails?.accountName || ""} onChange={updateMaster("bankDetails.accountName")} placeholder="Account holder name" />
        <Field title="Account number" value={master.bankDetails?.accountNumber || ""} onChange={updateMaster("bankDetails.accountNumber")} placeholder="Account number" />
        <Field title="IFSC code" value={master.bankDetails?.ifscCode || ""} onChange={updateMaster("bankDetails.ifscCode")} placeholder="IFSC code" />
        <Field title="Branch" value={master.bankDetails?.branchName || ""} onChange={updateMaster("bankDetails.branchName")} placeholder="Branch name" />
        <Field title="UPI ID" value={master.bankDetails?.upiId || ""} onChange={updateMaster("bankDetails.upiId")} placeholder="upi@bank" />
      </div>
    </>
  );
}
