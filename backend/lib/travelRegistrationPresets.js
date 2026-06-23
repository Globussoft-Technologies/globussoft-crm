// Travel registration-form audience presets.
//
// Single source of truth for the `registrationForm` landing-page block.
// Both the public renderer (backend/services/landingPageRenderer.js) and
// the admin builder UI (frontend/src/pages/LandingPageBuilder.jsx) read
// from here so a new audience only needs to be added in one place.
//
// Each preset returns:
//   audience    — stable key written into the form submission body so
//                 lead-routing rules can filter on it.
//   subBrand    — optional sub-brand key linking the preset to a travel
//                 sub-brand (tmc / rfu / travelStall / visaSure). Used by
//                 the lead-router to attribute leads to the right desk.
//   label       — admin-facing display name in the audience picker.
//   description — short hint shown under the picker.
//   fields      — default form-field shape ({ label, name, type, required }).
//                 The admin can still add/remove/rename fields after
//                 picking a preset; the preset just seeds the defaults.
//   submitText  — default CTA button label.
//   thankYou    — default post-submit message.
//
// Why a closed enumeration rather than free-text audience strings: the
// audience value flows downstream into lead-routing + analytics; a
// closed list keeps that join-key stable and prevents routing rules
// from rotting when someone types "TMC" vs "tmc-school" vs "TMC-Trips".

const PRESETS = {
  tmc: {
    audience: 'tmc',
    subBrand: 'tmc',
    label: 'TMC — School Trips',
    description: 'Parent-targeted registration for TMC school/college trip enquiries.',
    fields: [
      { label: "Parent's name", name: 'name', type: 'text', required: true },
      { label: 'Phone number', name: 'phone', type: 'tel', required: true },
      { label: 'Select school', name: 'school', type: 'text', required: true },
      { label: "Parent's email", name: 'email', type: 'email', required: true },
    ],
    submitText: 'Download programme brochure →',
    thankYou: 'Thank you — your school trip information is on the way.',
  },
  rfu: {
    audience: 'rfu',
    subBrand: 'rfu',
    label: 'RFU — Umrah Pilgrimage',
    description: 'Pilgrim-targeted registration for Umrah package enquiries.',
    fields: [
      { label: 'Full name', name: 'name', type: 'text', required: true },
      { label: 'Phone number', name: 'phone', type: 'tel', required: true },
      { label: 'Email', name: 'email', type: 'email', required: true },
      { label: 'Number of pilgrims', name: 'pilgrimCount', type: 'number', required: true },
      { label: 'Preferred travel month', name: 'preferredMonth', type: 'text', required: false },
    ],
    submitText: 'Request Umrah package details',
    thankYou: 'Thank you — our Umrah desk will contact you within one working day.',
  },
  travelStall: {
    audience: 'travelStall',
    subBrand: 'travelStall',
    label: 'Travel Stall — Family Holidays',
    description: 'Family-holiday registration with destination + travel-date intake.',
    fields: [
      { label: 'Full name', name: 'name', type: 'text', required: true },
      { label: 'Phone number', name: 'phone', type: 'tel', required: true },
      { label: 'Email', name: 'email', type: 'email', required: true },
      { label: 'Travellers (adults)', name: 'adults', type: 'number', required: true },
      { label: 'Travellers (children)', name: 'children', type: 'number', required: false },
      { label: 'Preferred travel dates', name: 'travelDates', type: 'text', required: false },
    ],
    submitText: 'Get my holiday quote',
    thankYou: 'Thank you — a holiday specialist will share options shortly.',
  },
  visaSure: {
    audience: 'visaSure',
    subBrand: 'visaSure',
    label: 'Visa Sure — Visa Assistance',
    description: 'Visa-applicant registration with destination + visa-type intake.',
    fields: [
      { label: 'Full name', name: 'name', type: 'text', required: true },
      { label: 'Phone number', name: 'phone', type: 'tel', required: true },
      { label: 'Email', name: 'email', type: 'email', required: true },
      { label: 'Destination country', name: 'destinationCountry', type: 'text', required: true },
      { label: 'Visa type', name: 'visaType', type: 'text', required: false },
    ],
    submitText: 'Check my visa eligibility',
    thankYou: 'Thank you — a visa consultant will be in touch.',
  },
  inquiry: {
    audience: 'inquiry',
    subBrand: null,
    label: 'Generic Inquiry',
    description: 'Generic name + email + phone + message form. Use for any non-vertical landing page.',
    fields: [
      { label: 'Full name', name: 'name', type: 'text', required: true },
      { label: 'Email', name: 'email', type: 'email', required: true },
      { label: 'Phone number', name: 'phone', type: 'tel', required: false },
      { label: 'Message', name: 'message', type: 'text', required: false },
    ],
    submitText: 'Send enquiry',
    thankYou: 'Thank you — we will be in touch shortly.',
  },
  custom: {
    audience: 'custom',
    subBrand: null,
    label: 'Custom — build your own',
    description: 'Empty starter. Add the fields you need.',
    fields: [
      { label: 'Full name', name: 'name', type: 'text', required: true },
      { label: 'Email', name: 'email', type: 'email', required: true },
    ],
    submitText: 'Submit',
    thankYou: 'Thank you!',
  },
};

function listPresets() {
  return Object.values(PRESETS).map((p) => ({
    audience: p.audience,
    subBrand: p.subBrand,
    label: p.label,
    description: p.description,
  }));
}

function getPreset(audience) {
  if (!audience || typeof audience !== 'string') return null;
  return PRESETS[audience] || null;
}

function defaultPropsFor(audience) {
  const preset = getPreset(audience) || PRESETS.inquiry;
  return {
    audience: preset.audience,
    subBrand: preset.subBrand,
    title: preset.label.replace(/ —.*/, ''),
    subtitle: '',
    fields: preset.fields.map((f) => ({ ...f })),
    submitText: preset.submitText,
    thankYouMessage: preset.thankYou,
    enableCaptcha: false,
    leadRoutingRuleId: '',
    successRedirectUrl: '',
  };
}

module.exports = { PRESETS, listPresets, getPreset, defaultPropsFor };
