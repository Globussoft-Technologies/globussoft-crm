import { describe, expect, it } from "vitest";
import { validateGenericCrmInlinePhone } from "../utils/genericCrmPhoneValidation";

describe("validateGenericCrmInlinePhone", () => {
  it("identifies a dot as the invalid character", () => {
    expect(validateGenericCrmInlinePhone("+20.1234567890")).toBe(
      "The dot (.) is not allowed in phone numbers. Enter digits only, with an optional + at the beginning.",
    );
  });

  it("identifies a hash symbol as the invalid character", () => {
    expect(validateGenericCrmInlinePhone("+2012#34567890")).toBe(
      "The hash symbol (#) is not allowed in phone numbers. Enter digits only, with an optional + at the beginning.",
    );
  });

  it.each([
    ["+91,1234567890", "A comma (,) is not allowed in phone numbers. Enter digits only, with an optional + at the beginning."],
    ["+91 1234567890", "A space is not allowed in phone numbers. Enter digits only, with an optional + at the beginning."],
    ["+91-1234567890", "A hyphen (-) is not allowed in phone numbers. Enter digits only, with an optional + at the beginning."],
    ["+201234567890d", "The letter \"d\" is not allowed in phone numbers. Enter digits only, with an optional + at the beginning."],
    ["+91@1234567890", "The character \"@\" is not allowed in phone numbers. Enter digits only, with an optional + at the beginning."],
    ["+91(1234567890", "The character \"(\" is not allowed in phone numbers. Enter digits only, with an optional + at the beginning."],
    ["91+1234567890", "The + symbol is allowed only at the beginning of a phone number."],
  ])("reports the specific problem in %s", (phone, message) => {
    expect(validateGenericCrmInlinePhone(phone)).toBe(message);
  });

  it("reports the supported length separately", () => {
    expect(validateGenericCrmInlinePhone("123456")).toBe(
      "Phone number must contain 7 to 15 digits.",
    );
    expect(validateGenericCrmInlinePhone(`+${"1".repeat(16)}`)).toBe(
      "Phone number must contain 7 to 15 digits.",
    );
  });

  it("accepts empty and valid inline values", () => {
    expect(validateGenericCrmInlinePhone("")).toBe("");
    expect(validateGenericCrmInlinePhone("1234567")).toBe("");
    expect(validateGenericCrmInlinePhone("+911234567890")).toBe("");
  });
});
