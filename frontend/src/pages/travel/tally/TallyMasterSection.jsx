import { useRef } from "react";
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
  inputMode,
  maxLength,
  pattern,
  normalizeValue = (nextValue) => nextValue,
}) {
  return (
    <label style={label}>
      {title}
      {required ? " *" : ""}
      <input
        type={type}
        value={value}
        onChange={(event) => onChange(normalizeValue(event.target.value))}
        placeholder={placeholder}
        inputMode={inputMode}
        maxLength={maxLength}
        pattern={pattern}
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

function CalendarField({ title, value, pickerValue, onChange, placeholder }) {
  const pickerRef = useRef(null);
  const openPicker = () => {
    const picker = pickerRef.current;
    if (!picker) return;
    if (typeof picker.showPicker === "function") {
      picker.showPicker();
    } else {
      picker.focus();
      picker.click();
    }
  };

  return (
    <label style={{ ...label, position: "relative" }}>
      {title} *
      <input
        type="text"
        value={value}
        placeholder={placeholder}
        readOnly
        onClick={openPicker}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            openPicker();
          }
        }}
        style={{ ...input, cursor: "pointer" }}
      />
      <input
        ref={pickerRef}
        type="date"
        value={pickerValue}
        onChange={(event) => onChange(event.target.value)}
        tabIndex={-1}
        aria-hidden="true"
        style={{ position: "absolute", width: 1, height: 1, opacity: 0, pointerEvents: "none" }}
      />
    </label>
  );
}

const financialYearPickerValue = (value) => {
  const match = /^(\d{4})-\d{4}$/.exec(value);
  return match ? `${match[1]}-04-01` : "";
};

const financialYearToPickerValue = (value) => {
  const match = /^(\d{2})-(\d{2})-(\d{4})$/.exec(value);
  return match ? `${match[3]}-${match[2]}-${match[1]}` : "";
};

const displayIsoDate = (value) => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  return match ? `${match[3]}-${match[2]}-${match[1]}` : "";
};

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
        className="tally-master-grid"
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
        <CalendarField
          title="Financial year"
          value={master.financialYear}
          pickerValue={financialYearPickerValue(master.financialYear)}
          onChange={(date) => {
            if (!date) return;
            const [year, month] = date.split("-").map(Number);
            const startYear = month >= 4 ? year : year - 1;
            updateMaster("financialYear")(`${startYear}-${startYear + 1}`);
          }}
          placeholder="2026-2027"
        />
        <CalendarField
          title="Financial year to"
          value={master.financialYearTo}
          pickerValue={financialYearToPickerValue(master.financialYearTo)}
          onChange={(date) => {
            if (!date) return;
            const [year, month, day] = date.split("-");
            updateMaster("financialYearTo")(`${day}-${month}-${year}`);
          }}
          placeholder="31-03-2027"
        />
        <CalendarField
          title="Books beginning from"
          value={displayIsoDate(master.booksBeginningFrom)}
          pickerValue={master.booksBeginningFrom}
          onChange={updateMaster("booksBeginningFrom")}
          placeholder="01-04-2026"
        />
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
        <label className="tally-master-address" style={{ ...label, gridColumn: "span 2" }}>
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
        <Field
          title="Account number"
          value={master.bankDetails?.accountNumber || ""}
          onChange={updateMaster("bankDetails.accountNumber")}
          placeholder="9–18 digit account number"
          inputMode="numeric"
          maxLength={18}
          pattern="[0-9]{9,18}"
          normalizeValue={(value) => value.replace(/\D/g, "").slice(0, 18)}
        />
        <Field title="IFSC code" value={master.bankDetails?.ifscCode || ""} onChange={updateMaster("bankDetails.ifscCode")} placeholder="IFSC code" />
        <Field title="Branch" value={master.bankDetails?.branchName || ""} onChange={updateMaster("bankDetails.branchName")} placeholder="Branch name" />
        <Field title="UPI ID" value={master.bankDetails?.upiId || ""} onChange={updateMaster("bankDetails.upiId")} placeholder="upi@bank" />
      </div>
    </>
  );
}
