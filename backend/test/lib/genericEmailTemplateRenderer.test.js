const { renderGenericTemplate, resolveValue } = require("../../lib/genericEmailTemplateRenderer");

describe("Generic CRM email template rendering", () => {
  const context = {
    organization: { name: "Configured Organization" },
    contact: { first_name: "Asha", email: "asha@example.test" },
    customFields: [{ key: "mobile_number", label: "Mobile Number", value: "+91 99999 00000" }],
  };

  it("renders configured organization in body and subject aliases", () => {
    expect(renderGenericTemplate("{{company_name}} — {{organization.name}}", context)).toBe("Configured Organization — Configured Organization");
    expect(renderGenericTemplate("Welcome to {{company}}", context)).toBe("Welcome to Configured Organization");
  });

  it("resolves submitted values, formatting variants, aliases, and nested scalars", () => {
    expect(renderGenericTemplate("{{Mobile Number}} / {{contact.email}}", context)).toBe("+91 99999 00000 / asha@example.test");
    expect(renderGenericTemplate("{{mobile_number}} / {{mobile-number}} / {{mobileNumber}}", context)).toBe("+91 99999 00000 / +91 99999 00000 / +91 99999 00000");
    expect(renderGenericTemplate("{{contact.profile.name}}", { contact: { profile: { name: "Nested value" } } })).toBe("Nested value");
    expect(renderGenericTemplate("{{phone}}", { customFields: [{ key: "mobile_number", label: "Mobile Number", aliases: ["phone"], value: "555-0100" }] })).toBe("555-0100");
  });

  it("uses meaning-specific fallbacks for missing, null, undefined, empty, and object values", () => {
    expect(renderGenericTemplate("Hello {{contact.first_name}} {{company_name}} {{product_name}} {{unknown}}", { organization: { name: "" }, contact: { first_name: "" }, product: {} })).toBe("Hello there your company your products or services the requested information");
    expect(renderGenericTemplate("{{object}}", { object: { value: "secret" } })).toBe("the requested information");
    expect(renderGenericTemplate("{{missing_field}} / {{empty_field}} / {{empty_list}}", { empty_field: "", empty_list: "[]" })).toBe("the requested information / the requested information / the requested information");
    expect(renderGenericTemplate("{{contact.phone}} / {{contact.email}}", { contact: { phone: null, email: undefined } })).toBe("your phone number / your email address");
    expect(renderGenericTemplate("<p>{{contact.email}}</p>", { contact: { email: null } }, { html: true })).toBe("<p>your email address</p>");
  });

  it("keeps greetings and missing business information natural without fabrication", () => {
    const output = renderGenericTemplate("Hello {{first_name}}, explore {{product_name}} from {{company_name}}.", {});
    expect(output).toBe("Hello there, explore your products or services from your company.");
    expect(output).not.toMatch(/\{\{|\}\}|null|undefined|\[object Object\]/i);
    expect(output).not.toMatch(/@|\+\d|\$\d|\b(?:Inc|LLC|Ltd)\b/i);
  });

  it("supports sender details with configured values and neutral defaults", () => {
    expect(renderGenericTemplate("{{sender.name}} <{{sender.email}}> at {{sender.company}}", {
      sender: { name: "Configured Sender", email: "sender@example.test", company: "Configured Company" },
    })).toBe("Configured Sender <sender@example.test> at Configured Company");
    expect(renderGenericTemplate("{{sender.name}} / {{sender.email}} / {{sender.company}}", { sender: {} }))
      .toBe("our team / your email address / your company");
  });

  it("escapes dynamic HTML values while preserving the surrounding markup", () => {
    expect(renderGenericTemplate("<p>Hello {{contact.first_name}}</p>", { contact: { first_name: "<Asha> & 'team'" } }, { html: true })).toBe("<p>Hello &lt;Asha&gt; &amp; &#39;team&#39;</p>");
  });

  it("renders all supported scalar types as readable strings", () => {
    expect(renderGenericTemplate("{{count}} / {{enabled}}", { count: 3, enabled: false })).toBe("3 / false");
  });

  it("does not choose an ambiguous semantic field", () => {
    expect(resolveValue("contact number", { customFields: [
      { key: "mobile", label: "Mobile", value: "1" },
      { key: "phone", label: "Office Phone", value: "2" },
    ] })).toBeNull();
  });

  it("supports unambiguous semantic field matching", () => {
    expect(resolveValue("phone", { customFields: [{ key: "mobile_number", label: "Mobile Number", value: "555-0100" }] })).toBe("555-0100");
    expect(resolveValue("company_name", { customFields: [{ key: "organization_name", label: "Organization Name", value: "Acme" }] })).toBe("Acme");
  });

  it("does not leak unresolved placeholders or JSON objects", () => {
    const output = renderGenericTemplate("{{missing}} {{nested}} {{contact.unknown}}", { nested: { secret: "value" }, contact: {} });
    expect(output).not.toMatch(/\{\{|\}\}|\[object Object\]|\bnull\b|\bundefined\b/);
    expect(output).not.toContain("secret");
  });
});
