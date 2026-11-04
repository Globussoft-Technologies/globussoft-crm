import LeadFields from "./LeadFields";

/**
 * Generic CRM field configuration surface.
 *
 * This intentionally reuses the established lead-custom-fields editor and
 * API. The route and sidebar entry are generic-only; the older Lead Fields
 * settings route remains available to its existing callers.
 */
export default function FieldConfig() {
  return (
    <LeadFields
      pageTitle="Field Config"
      pageDescription="Review the built-in lead fields and configure the custom fields used across your generic CRM."
      showSystemFields
    />
  );
}
