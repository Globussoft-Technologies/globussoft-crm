#!/usr/bin/env node
/**
 * render-pr-e-phase1-samples.js (PR-E Phase 1.5 — 6 destinations).
 *
 * One-shot script that renders SIX sample destinations to demonstrate
 * that the post-Option-B architecture is fully destination-agnostic:
 *
 *   • Japan       — educational family   + educational-academic theme
 *   • Bali        — family family        + family-tropical theme
 *   • Umrah       — religious family     + religious-classical theme
 *   • Switzerland — luxury family        + luxury-alpine theme
 *   • Iceland     — luxury family        + luxury-alpine theme        (NEW)
 *   • Vietnam     — family family        + family-tropical theme      (NEW)
 *
 * The four original destinations are sample renders, NOT destination-
 * specific implementations. Iceland + Vietnam prove the point: they
 * route to existing family-generic themes (luxury-alpine,
 * family-tropical) without any new template / theme / renderer code.
 * Any future destination (Norway, Turkey, Egypt, Kerala, Kashmir, NZ)
 * lands the same way — the Phase 2 Travel Experience Engine picks
 * (family, variant) from inputs; this script does it manually for
 * demonstration.
 *
 * Run:    node backend/scripts/render-pr-e-phase1-samples.js
 * Output: docs/PR_E_PHASE1_SAMPLES/{japan,bali,umrah,switzerland,iceland,vietnam}.html
 */

'use strict';

const fs = require('fs');
const path = require('path');
const educationalTripV1 = require('../services/templates/educationalTripV1');
const religiousTourV1   = require('../services/templates/religiousTourV1');
const familyTripV1      = require('../services/templates/familyTripV1');
const luxuryTourV1      = require('../services/templates/luxuryTourV1');

const OUT_DIR = path.resolve(__dirname, '..', '..', 'docs', 'PR_E_PHASE1_SAMPLES');

// ── Sample content payloads ─────────────────────────────────────────
// Each carries the SAME schema (semantic content slots — no destination-
// specific branches anywhere). The only thing that varies between
// destinations is: (a) which family TEMPLATE renders them and (b) which
// family-generic THEME they pick. Both decisions live in the script
// arguments at the bottom — not in the content data.

const JAPAN = {
  brand: {
    kanji: '日本', label: 'JAPAN 2026',
    programmeName: 'Japan 2026 Educational Immersion',
    programmeTagline: 'Heritage, discipline, and contemporary growth.',
    // Phase 1.6 — partner logos render with mix-blend-mode: multiply.
    // (Using inline SVG data URIs so the sample has no external deps.)
    partnerLogos: [
      { src: "data:image/svg+xml;utf8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 240 60'%3E%3Crect width='240' height='60' fill='%23ffffff'/%3E%3Ctext x='120' y='38' text-anchor='middle' font-family='Georgia' font-size='22' fill='%231f1a17'%3EThe Modern Classroom%3C/text%3E%3C/svg%3E", alt: 'The Modern Classroom' },
      { src: "data:image/svg+xml;utf8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 240 60'%3E%3Crect width='240' height='60' fill='%23ffffff'/%3E%3Ctext x='120' y='38' text-anchor='middle' font-family='Georgia' font-size='22' fill='%231f1a17'%3ETravel Stall%3C/text%3E%3C/svg%3E", alt: 'Travel Stall' },
    ],
  },
  nav: { links: [{ label: 'Programme', href: '#programme' }, { label: 'Cultural', href: '#cultural' }, { label: 'Safety', href: '#safety' }, { label: 'Investment', href: '#investment' }, { label: 'FAQs', href: '#faqs' }], ctaText: 'Register Now', ctaHref: '#register' },
  hero: {
    kanjiWatermark: '成長',
    eyebrow: { date: 'OCT-NOV 2026', audience: 'STUDENTS · GRADES 8-12', batchPill: 'Limited to 24 students' },
    kicker: '09 Days. 04 Cities.',
    headline: 'Japan 2026 — Heritage Meets Tomorrow.',
    lede: 'Tokyo, Kyoto, Osaka and Nara. A structured cultural immersion designed for serious students.',
    benefitCards: [
      { icon: '◈', title: 'Academic Rigour', desc: 'University-led campus visits.' },
      { icon: '⊕', title: 'Cultural Depth', desc: 'Tea, calligraphy, temple etiquette.' },
      { icon: '⌂', title: 'Pre-vetted Safety', desc: '1:6 host ratio at every stop.' },
      { icon: '❖', title: 'Lifetime Network', desc: 'Alumni cohort beyond the trip.' },
    ],
    countdown: { label: 'EARLY-BIRD CLOSES IN', deadlineIso: '2026-04-30T23:59:59+05:30', ctaText: 'Reserve Your Seat', ctaHref: '#register' },
    visualTitle: 'Japan 2026 Educational Immersion',
    visualSub: 'A structured 9-day programme across four cities.',
    posterAlt: 'Japan 2026 hero',
  },
  marquee: { cities: [{ tag: 'METROPOLIS', title: 'Tokyo' }, { tag: 'IMPERIAL CITY', title: 'Kyoto' }, { tag: 'KITCHEN OF JAPAN', title: 'Osaka' }, { tag: 'ANCIENT CAPITAL', title: 'Nara' }] },
  programme: {
    show: true, leftHeadline: 'Why Japan, why now.',
    leftParagraphs: ['Japan rewards the prepared student. The discipline of the tea ceremony, the rigour of temple craft, and the modern velocity of Tokyo — together they teach focus, respect, and ambition.', 'Tokyo · Kyoto · Osaka · Nara — Mt. Fuji, Senso-ji, Fushimi Inari, Osaka Castle, Nara deer park.'],
    rightHeadline: 'What Students Gain', rightChecks: ['Cultural fluency', 'University-readiness exposure', 'Cross-border friendships', 'Discipline through ritual'],
  },
  cultural: {
    show: true, tag: 'CULTURAL HIGHLIGHTS', title: 'Cultural Highlights',
    items: [
      { id: 'tokyo', icon: 'tokyo', name: 'Tokyo', label: 'METROPOLIS', body: ['Shibuya scramble, Akihabara robotics labs, Tokyo Skytree.'], benefit: 'Modernity at full velocity.' },
      { id: 'fuji', icon: 'fuji', name: 'Mt. Fuji', label: 'SUMMIT', body: ['Day trek to the 5th station, contemplation at Lake Kawaguchiko.'], benefit: 'Reverence for scale.' },
      { id: 'kyoto', icon: 'kyoto', name: 'Kyoto', label: 'IMPERIAL', body: ['Fushimi Inari, Kinkaku-ji, tea ceremony with a master.'], benefit: 'Ritual as discipline.' },
      { id: 'nara', icon: 'nara', name: 'Nara', label: 'ANCIENT', body: ['Todai-ji great Buddha, deer park, Heijo Palace.'], benefit: 'Heritage as foundation.' },
      { id: 'osaka', icon: 'osaka', name: 'Osaka', label: 'KITCHEN', body: ['Dotonbori, Osaka Castle, takoyaki workshop.'], benefit: 'Joy in the everyday.' },
    ],
  },
  safety: {
    show: true, title: 'Engineered for Safety. Designed for Growth.',
    subtitle: 'Trip-tested ratios, vetted stays, and a 24/7 hotline.',
    // Phase 1.6 stat tiles — the biggest trust treatment from the reference.
    stats: [
      { stat: '1:6', title: 'Host Ratio', body: 'One trained Japan-based guide for every six students.' },
      { stat: '4★', title: 'Vetted Stays', body: 'Pre-inspected hotels, twin sharing throughout.' },
      { stat: '24/7', title: 'On-Call Desk', body: 'Round-the-clock India-based support line.' },
      { stat: '✈', title: 'Return Flights', body: 'Full-service carriers, group travel both legs.' },
    ],
    features: [
      { icon: 'shield', title: 'Pre-vetted host families', desc: 'Each homestay inspected and certified.' },
      { icon: 'briefcase', title: 'Travel insurance', desc: 'Comprehensive medical + trip cancellation cover.' },
      { icon: 'send', title: 'Door-to-door transport', desc: 'Bangalore-to-Osaka-and-back, all transfers.' },
      { icon: 'package', title: 'Curated meals', desc: 'Halal / Veg / Jain options pre-confirmed.' },
    ],
    included: { title: "What's Included", items: ['Return flights', 'All accommodation', 'All meals', 'Visa processing', 'Travel insurance', 'Local transport', 'Cultural workshops', 'Photography'] },
    banner: { title: "Your child's safety, end-to-end.", body: 'Door-to-door from Bangalore to Osaka and back.', ctaText: 'Reserve Their Seat', ctaHref: '#register' },
    quote: 'Independence within structure.',
  },
  investment: {
    show: true, tag: 'TRANSPARENT PROGRAMME INVESTMENT', title: 'Transparent Programme Investment', currency: '₹',
    // Phase 1.6 — featuredIndex marks tier 0 with stronger badge + scale.
    featuredIndex: 0,
    featuredBadge: 'RESERVE FIRST',
    tiers: [
      { step: 1, title: 'Booking', subtitle: 'Reserve the seat', amount: '50,000', tag: 'Non-refundable', date: '30 Apr 2026', vendor: 'The Modern Classroom' },
      { step: 2, title: 'Mid-payment', subtitle: 'Pre-departure', amount: '1,25,000', date: '15 Jul 2026', vendor: 'The Modern Classroom' },
      { step: 3, title: 'Balance', subtitle: 'Final clearance', amount: '1,25,000', date: '15 Sep 2026', vendor: 'The Modern Classroom' },
    ],
    inclusions: { label: 'INDICATIVE INCLUSIONS', items: ['Return airfare', 'All accommodation', 'All meals', 'Visa processing', 'Travel insurance', 'Workshops'] },
  },
  registration: {
    show: true, tag: 'REGISTRATION', title: 'Register Your Interest',
    intro: 'Tell us about the participant and we will be in touch within one business day.',
    schoolOptions: ['Bangalore International', 'Delhi Public School', 'Mallya Aditi', 'Inventure Academy'],
    leadSubBrand: 'tmc', tenantSlug: 'travel-stall',
    // Phase 1.6 — covers panel sits beside the form.
    coversTitle: 'What you receive after registering',
    coversIntro: 'Within one business day you get the full picture so you can decide with clarity.',
    covers: [
      { title: 'Full Itinerary', body: 'The complete day-by-day plan across Tokyo, Kyoto, Osaka, Nara.' },
      { title: 'Safety Framework', body: 'Our 1:6 supervision model and 24/7 hotline details.' },
      { title: 'Cost Sheet', body: 'Transparent three-instalment breakdown — no hidden costs.' },
      { title: 'Direct Q&A', body: 'A scheduled call with the programme team.' },
    ],
  },
  faq: {
    show: true, tag: 'CLARIFICATIONS', title: 'Frequently Asked Questions',
    categories: [
      { id: 'all', label: 'All', icon: '📋' }, { id: 'tour', label: 'Tour', icon: '📍' }, { id: 'logistics', label: 'Logistics', icon: '✈' }, { id: 'safety', label: 'Safety', icon: '🛡' },
    ],
    items: [
      { cat: 'tour', q: 'How long is the programme?', a: 'Nine days across four cities.' },
      { cat: 'tour', q: 'What ages is it for?', a: 'Grades 8-12, grouped by age band.' },
      { cat: 'logistics', q: 'Are flights included?', a: 'Yes — return flights with full-service carriers.' },
      { cat: 'safety', q: 'What is the staff ratio?', a: '1:6 — one Japan-based guide for every six students.' },
      { cat: 'safety', q: 'Is insurance included?', a: 'Yes — comprehensive medical + trip insurance.' },
    ],
  },
  finalCta: {
    show: true, eyebrow: '09 DAYS · 04 CITIES', title: 'Give Them Japan, Properly.', subtitle: 'One structured, supervised, life-shaping journey.',
    steps: [{ label: 'Register interest' }, { label: 'Reserve the seat' }, { label: 'Travel with confidence' }],
    ctaLabel: 'REGISTER NOW', ctaHref: '#register',
  },
  contact: {
    show: true, kanji: '日本', label: 'JAPAN 2026', tagline: 'A structured cultural immersion.',
    sections: [
      { label: 'EMAIL', lines: ['japan@themodernclassroom.in'] },
      { label: 'PHONE', lines: ['+91 80 1234 5678'] },
      { label: 'OFFICE', lines: ['Bangalore, India', 'Mon-Sat 09:00-18:00 IST'] },
    ],
    copyright: '© 2026 The Modern Classroom · A Travel Stall programme',
  },
  floatingCta: { show: true, text: 'REGISTER NOW', href: '#register' },
};

const BALI = {
  brand: { label: 'BALI 2026 FAMILY', programmeName: 'Bali Family Holiday 2026', programmeTagline: 'Sun, sand, and slow family time.' },
  nav: { links: [{ label: 'Highlights', href: '#cultural' }, { label: 'Safety', href: '#safety' }, { label: 'Pricing', href: '#investment' }, { label: 'FAQs', href: '#faqs' }], ctaText: 'Book This Trip', ctaHref: '#register' },
  hero: {
    eyebrow: { date: 'JUL 2026', audience: 'FAMILY · 2 ADULTS + 2 KIDS', batchPill: 'Family-friendly' },
    kicker: '07 Days. 03 Regions.', headline: 'Bali Family 2026 — Slow, Saline, Sacred.',
    lede: 'Ubud rice terraces, Sidemen valleys, Amed reefs. A holiday built for the whole family.',
    benefitCards: [
      { icon: '☀', title: 'Beach Time Daily', desc: 'Sun-up to sun-down.' },
      { icon: '🌴', title: 'Kid Activities', desc: 'Reef walks, surf lessons.' },
      { icon: '🍳', title: 'Easy Meals', desc: 'Tested for picky eaters.' },
      { icon: '📸', title: 'Photo Moments', desc: 'Lifetime memories.' },
    ],
    countdown: { label: 'EARLY-BIRD CLOSES IN', deadlineIso: '2026-06-15T23:59:59+05:30', ctaText: 'Reserve This Trip', ctaHref: '#register' },
    visualTitle: 'Bali Family Field Holiday', visualSub: 'Ecology, culture, and family time in three regions.', posterAlt: 'Bali family holiday hero',
  },
  marquee: { cities: [{ tag: 'HIGHLANDS', title: 'Ubud' }, { tag: 'TERRACES', title: 'Sidemen' }, { tag: 'COASTAL', title: 'Amed' }] },
  cultural: {
    show: true, tag: "WHAT YOU'LL DO", title: 'Activities Built For Family Fun',
    items: [
      { id: 'ubud', icon: 'palm', name: 'Ubud', label: 'HIGHLANDS', body: ['Craft villages, Monkey Forest, working art studio.'], benefit: 'Patience and attention to detail.' },
      { id: 'sidemen', icon: 'temple', name: 'Sidemen', label: 'TERRACES', body: ['Subak rice-terrace walks, water-sharing systems explained.'], benefit: 'Systems thinking made visible.' },
      { id: 'amed', icon: 'wave', name: 'Amed', label: 'COASTAL', body: ['Snorkel reef surveys with a marine biologist.'], benefit: 'Science is something you DO.' },
    ],
  },
  safety: {
    show: true, title: 'Family Safe. Travel Easy.',
    subtitle: 'Kid-tested properties and a 24/7 hotline parents can use.',
    stats: [
      { stat: '1:8', title: 'Family Ratio', body: 'One coordinator for every 8 family members.' },
      { stat: '5★', title: 'Kid-Safe Stays', body: 'Pool-fenced family rooms, vetted resorts.' },
      { stat: '24/7', title: 'Parent Hotline', body: 'India-based number, always answered.' },
      { stat: '🛂', title: 'Visa Handled', body: 'We sort the e-visa; you sign and travel.' },
    ],
    features: [
      { icon: 'shield', title: 'Kid-safe properties', desc: 'Inspected hotels, twin sharing, child-proof rooms.' },
      { icon: 'briefcase', title: 'Health & wellness', desc: 'Registered nurse + travel insurance.' },
      { icon: 'send', title: '24/7 support', desc: 'Round-the-clock contact line.' },
      { icon: 'package', title: 'Door-to-door', desc: 'Airport-to-hotel, all transport sorted.' },
    ],
    included: { title: "What's Included", items: ['Return flights', 'All accommodation', 'All meals', 'Visa on arrival', 'Travel insurance', 'Private transport', 'Activities', 'Photo album'] },
  },
  investment: {
    show: true, tag: 'TRANSPARENT PRICING', title: 'Family Holiday Pricing', currency: '₹',
    featuredIndex: 0, featuredBadge: 'BOOK FIRST',
    tiers: [
      { step: 1, title: 'Booking Fee', subtitle: 'Non-refundable', amount: '25,000', date: '20 Apr 2026', vendor: 'Travel Stall' },
      { step: 2, title: 'Balance', subtitle: 'Pre-departure', amount: '1,40,000', date: '20 May 2026', vendor: 'Travel Stall' },
    ],
    inclusions: { label: 'INDICATIVE INCLUSIONS', items: ['Airfare', 'Hotels (twin)', 'All meals', 'Activities', 'Insurance', 'Supervision'] },
  },
  registration: {
    show: true, tag: 'BOOK THIS TRIP', title: 'Hold Your Dates',
    leadSubBrand: 'travelstall', tenantSlug: 'travel-stall',
    coversTitle: 'What you get within 24 hours',
    coversIntro: 'A full plan to share with the whole family before deciding.',
    covers: [
      { title: 'Day-By-Day Plan', body: 'Ubud → Sidemen → Amed activities and timings.' },
      { title: 'Safety Brief', body: 'Properties, ratios, medical cover.' },
      { title: 'Activities Menu', body: 'Reef walks, crafts, food experiences.' },
      { title: 'Cost Sheet', body: 'Transparent two-instalment breakdown.' },
    ],
  },
  faq: {
    show: true, tag: 'FAMILY QUESTIONS', title: 'Frequently Asked',
    categories: [{ id: 'all', label: 'All Questions', icon: '◇' }, { id: 'family', label: 'For Families', icon: '👨‍👩‍👧‍👦' }, { id: 'safety', label: 'Safety', icon: '🛡' }],
    items: [
      { cat: 'family', q: 'Is this kid-friendly?', a: 'Yes — activities curated for ages 6-16.' },
      { cat: 'family', q: 'What about picky eaters?', a: 'All meals offered with Indian / continental options.' },
      { cat: 'safety', q: 'Is a doctor on call?', a: 'Yes — registered nurse on the trip plus 24/7 doctor hotline.' },
    ],
  },
  finalCta: {
    show: true, eyebrow: '07 DAYS · 03 REGIONS', title: 'A Family Trip Worth The Photos.', subtitle: 'Reef walks, terraces, sunsets — all sorted.',
    steps: [{ label: 'Reserve dates' }, { label: 'Personalise activities' }, { label: 'Travel together' }],
    ctaLabel: 'BOOK THIS TRIP', ctaHref: '#register',
  },
  contact: {
    show: true, label: 'BALI FAMILY 2026', tagline: 'Where curiosity meets the wild.',
    sections: [{ label: 'EMAIL', lines: ['family@travelstall.in'] }, { label: 'PHONE', lines: ['+91 90000 12345'] }],
    copyright: '© 2026 Travel Stall',
  },
  floatingCta: { show: true, text: 'BOOK THIS TRIP', href: '#register' },
};

const UMRAH = {
  brand: { label: 'UMRAH 2026', programmeName: 'Umrah Pilgrimage 2026', programmeTagline: 'A pilgrimage worth preparing for.' },
  // brand.kanji left empty — theme.decorative.brand (الحج) fills in.
  nav: { links: [{ label: 'Journey', href: '#programme' }, { label: 'Holy Sites', href: '#cultural' }, { label: 'Trust & Care', href: '#safety' }, { label: 'Investment', href: '#investment' }, { label: 'FAQs', href: '#faqs' }], ctaText: 'Reserve Your Place', ctaHref: '#register' },
  hero: {
    // kanjiWatermark left empty — theme.decorative.watermark (الإيمان) fills in.
    eyebrow: { date: "SHA'BAN 1447 · MAR 2026", audience: 'PILGRIMS · ALL AGES', batchPill: 'Limited to 40 pilgrims' },
    kicker: '14 Days. 2 Holy Cities.', headline: 'Umrah 2026 — Scholar-Led, Family-Cared.',
    lede: "Makkah and Madinah, with three-times-daily group du'a, scholar-led guidance, and elderly-first care.",
    benefitCards: [
      { icon: '☪', title: 'Scholar-Led', desc: "Daily du'a and pilgrimage classes." },
      { icon: '✦', title: 'Elderly Care', desc: 'Wheelchair access, doctor on call.' },
      { icon: '✧', title: 'Group Dignity', desc: 'Small group, attentive service.' },
      { icon: '◈', title: 'Near-Haram Stays', desc: '5-minute walk to Masjid al-Haram.' },
    ],
    countdown: { label: 'BOOKINGS CLOSE IN', deadlineIso: '2026-02-15T23:59:59+05:30', ctaText: 'Reserve Your Place', ctaHref: '#register' },
    visualTitle: 'Umrah 2026 — Scholar-Led Journey', visualSub: 'Makkah · Madinah · 14 days of structured pilgrimage.', posterAlt: 'Umrah pilgrimage hero',
  },
  marquee: { cities: [{ tag: 'HOLY MAKKAH', title: 'Makkah' }, { tag: 'CITY OF THE PROPHET', title: 'Madinah' }] },
  programme: {
    show: true, leftHeadline: 'Why this pilgrimage.',
    leftParagraphs: [
      'Maulana Aslam Sahab leads each day with a structured rhythm — Fajr in the Haram, scholar-led tafseer after Zuhr, and personal reflection time after Maghrib.',
      'Elderly pilgrims are accompanied at every step; wheelchair access pre-arranged at both holy mosques.',
      'A pilgrimage that asks one thing of you: be present.',
    ],
    rightHeadline: 'What Pilgrims Carry Home',
    rightChecks: ['Spiritual clarity', 'A practiced rhythm of prayer', 'Lifelong companion-pilgrims', "A deepened connection with the Qur'an"],
  },
  cultural: {
    show: true, tag: 'HOLY SITES', title: 'Sites You Will Walk',
    items: [
      { id: 'kaaba', icon: 'kaaba', name: 'The Kaaba', label: 'MASJID AL-HARAM', body: ['Tawaaf at dawn, supplication at the Multazam, time with the Black Stone.'], benefit: 'The heart of the journey.' },
      { id: 'mosque', icon: 'mosque', name: 'Masjid al-Haram', label: 'MAKKAH', body: ["Five-times-daily prayers at the source — and a group du'a circle after each."], benefit: 'Discipline meets devotion.' },
      { id: 'nabawi', icon: 'dome', name: 'Masjid an-Nabawi', label: 'MADINAH', body: ["Visit to the Prophet's Mosque, Riad ul-Jannah, and the Baqi cemetery."], benefit: 'The place of peace.' },
      { id: 'minaret', icon: 'minaret', name: 'Quba Mosque', label: 'OUTSIDE MADINAH', body: ['The first mosque built by the Prophet — a quiet pilgrimage in itself.'], benefit: 'Where it all began.' },
    ],
  },
  safety: {
    show: true, title: 'Cared For, Every Step.',
    subtitle: 'Scholar-led, doctor-accompanied, elderly-first.',
    stats: [
      { stat: '1:20', title: 'Pilgrim Care', body: 'One trained companion per twenty pilgrims.' },
      { stat: '5min', title: 'Walk To Haram', body: 'Both Makkah and Madinah hotels within 5 minutes.' },
      { stat: '24/7', title: 'Doctor On Call', body: 'A registered medical doctor on tour at all times.' },
      { stat: '♿', title: 'Wheelchair Ready', body: 'Pre-arranged at both holy mosques.' },
    ],
    features: [
      { icon: 'shield', title: 'Doctor on tour', desc: 'Registered medical doctor accompanies the group.' },
      { icon: 'briefcase', title: 'Elderly first', desc: 'Wheelchair access pre-arranged; rest breaks built in.' },
      { icon: 'shieldCheck', title: 'Insurance covered', desc: 'Comprehensive medical + travel insurance.' },
      { icon: 'package', title: 'Near-Haram hotels', desc: '5-minute walk; clean, vetted, female-safe.' },
    ],
    included: { title: "What's Included", items: ['Return flights from Bangalore', 'All accommodation near Haram', 'Three meals daily (halal)', 'Visa & ihram kit', 'Doctor on tour', 'Wheelchair on request', 'Ziyaarat van', 'Scholar-led classes'] },
    banner: { title: 'Travel light. Travel cared for.', body: 'Everything from visa to ihram kit included.', ctaText: 'Reserve Your Place', ctaHref: '#register' },
  },
  investment: {
    show: true, tag: 'PILGRIMAGE INVESTMENT', title: 'Transparent Pilgrimage Investment', currency: '₹',
    featuredIndex: 0, featuredBadge: 'RESERVE FIRST',
    tiers: [
      { step: 1, title: 'Reservation', subtitle: 'Booking deposit', amount: '50,000', tag: 'Non-refundable', date: '20 Dec 2025', vendor: 'Rahmat Foundation' },
      { step: 2, title: 'Visa Stage', subtitle: 'Pre-visa payment', amount: '85,000', date: '20 Jan 2026', vendor: 'Rahmat Foundation' },
      { step: 3, title: 'Final Balance', subtitle: 'Pre-departure', amount: '60,000', date: '20 Feb 2026', vendor: 'Rahmat Foundation' },
    ],
    inclusions: { label: 'INDICATIVE INCLUSIONS', items: ['Return flights', 'Hotel near Haram', 'Three halal meals daily', 'Saudi visa', 'Ihram kit', 'Doctor on tour'] },
  },
  registration: {
    show: true, tag: 'REGISTRATION', title: 'Reserve Your Place',
    leadSubBrand: 'rfu', tenantSlug: 'travel-stall',
    coversTitle: 'What you receive when you reserve',
    coversIntro: 'A complete pilgrimage plan within 24 hours of registration.',
    covers: [
      { title: 'Pilgrimage Itinerary', body: 'Daily prayer + ziyaarat schedule across Makkah and Madinah.' },
      { title: 'Care Framework', body: 'Doctor, wheelchair, dietary, elderly-first protocols.' },
      { title: 'Documentation', body: 'Visa list, ihram kit specs, travel docs checklist.' },
      { title: 'Direct Q&A', body: 'A scheduled call with the lead scholar.' },
    ],
  },
  faq: {
    show: true, tag: 'CLARIFICATIONS', title: 'Frequently Asked Questions',
    categories: [{ id: 'all', label: 'All', icon: '◇' }, { id: 'spiritual', label: 'Spiritual', icon: '☪' }, { id: 'logistics', label: 'Logistics', icon: '✈' }, { id: 'care', label: 'Care', icon: '✚' }],
    items: [
      { cat: 'spiritual', q: "How are the daily du'a circles structured?", a: "Three group du'a sessions daily after Fajr, Zuhr, and Maghrib — led by Maulana Aslam Sahab." },
      { cat: 'logistics', q: 'Are the hotels close to Masjid al-Haram?', a: 'Yes — both Makkah and Madinah hotels are within a 5-minute walk.' },
      { cat: 'care', q: 'Is wheelchair access pre-arranged?', a: 'Yes — at both Masjid al-Haram and Masjid an-Nabawi.' },
      { cat: 'logistics', q: 'What is included in the ihram kit?', a: 'Two-piece ihram cloth, belt, slippers, and a travel pouch.' },
    ],
  },
  finalCta: {
    show: true, eyebrow: '14 DAYS · 2 HOLY CITIES', title: 'A Pilgrimage, Properly Led.', subtitle: 'Scholar-led, family-cared, elderly-first.',
    steps: [{ label: 'Reserve' }, { label: 'Prepare' }, { label: 'Pilgrimage' }],
    ctaLabel: 'RESERVE YOUR PLACE', ctaHref: '#register',
  },
  contact: {
    show: true, label: 'UMRAH 2026', tagline: 'A pilgrimage worth preparing for.',
    sections: [{ label: 'EMAIL', lines: ['umrah@rahmatfoundation.org'] }, { label: 'PHONE', lines: ['+91 80 1234 5678'] }, { label: 'OFFICE', lines: ['Hyderabad, India', 'Mon-Sun 09:00-21:00 IST'] }],
    copyright: '© 2026 Rahmat Foundation · A Travel Stall programme',
  },
  floatingCta: { show: true, text: 'RESERVE YOUR PLACE', href: '#register' },
};

const SWITZERLAND = {
  brand: { label: 'PRIVATE COLLECTION · SWITZERLAND', programmeName: 'Switzerland — A Quiet Journey', programmeTagline: 'Curated. Quiet. Considered.' },
  nav: { links: [{ label: 'Experience', href: '#hero' }, { label: 'Curation', href: '#cultural' }, { label: 'Investment', href: '#investment' }, { label: 'FAQs', href: '#faqs' }], ctaText: 'Enquire', ctaHref: '#register' },
  hero: {
    eyebrow: { date: 'SEP-OCT 2026', audience: 'COUPLES · DISCERNING TRAVELLERS', batchPill: 'BY APPLICATION' },
    kicker: '10 Days. 4 Quiet Towns.',
    headline: 'Switzerland — A Quietly Extraordinary Journey.',
    lede: 'Zermatt, Interlaken, Lucerne, and Lake Geneva. By private train and chauffeur, in handpicked properties most travellers will never see.',
    benefitCards: [
      { icon: '✦', title: 'Private', desc: 'No groups. No queues. Just you.' },
      { icon: '◈', title: 'Curated', desc: 'Hand-chosen properties.' },
      { icon: '◊', title: 'Considered', desc: 'Each detail intentional.' },
      { icon: '✧', title: 'Quiet', desc: 'Designed for slow.' },
    ],
    countdown: { label: 'APPLICATIONS CLOSE', deadlineIso: '2026-04-30T23:59:59+05:30', ctaText: 'Apply', ctaHref: '#register' },
    visualTitle: 'Switzerland Private Collection 2026', visualSub: 'A 10-day curation across four alpine retreats.', posterAlt: 'Switzerland luxury hero',
  },
  marquee: { cities: [{ tag: 'MATTERHORN', title: 'Zermatt' }, { tag: 'JUNGFRAU REGION', title: 'Interlaken' }, { tag: 'OLD-WORLD CHARM', title: 'Lucerne' }, { tag: 'LAKE GENEVA', title: 'Vevey' }] },
  cultural: {
    show: true, tag: 'CURATION', title: 'Each Stay, A Story.',
    items: [
      { id: 'zermatt', icon: 'alps', name: 'Zermatt', label: 'MATTERHORN', body: ['A chalet with a private balcony facing the Matterhorn. Mornings in silence.'], benefit: 'Reverence for scale.' },
      { id: 'interlaken', icon: 'chalet', name: 'Interlaken', label: 'JUNGFRAU', body: ['A historic property between two lakes. A private boat at sunset.'], benefit: 'Stillness made visible.' },
      { id: 'lucerne', icon: 'lake', name: 'Lucerne', label: 'OLD-WORLD', body: ['A 19th-century waterfront hotel. Coffee at the Chapel Bridge before the city wakes.'], benefit: 'Time slows down.' },
      { id: 'vevey', icon: 'lake', name: 'Vevey', label: 'LAKE GENEVA', body: ['A vineyard estate above the lake. Wine with the family who makes it.'], benefit: 'Conversation as ritual.' },
    ],
  },
  investment: {
    show: true, tag: 'INVESTMENT', title: 'Investment', currency: '€',
    featuredIndex: 0, featuredBadge: 'START WITH A CALL',
    tiers: [
      { step: 1, title: 'Application Fee', subtitle: 'Discovery call', amount: '500', tag: 'Refundable on booking', date: 'On enquiry', vendor: 'Travel Stall Private' },
      { step: 2, title: 'Booking', subtitle: 'Reserve the journey', amount: '4,500', date: '60 days prior', vendor: 'Travel Stall Private' },
      { step: 3, title: 'Balance', subtitle: 'Final clearance', amount: '9,000', date: '14 days prior', vendor: 'Travel Stall Private' },
    ],
    inclusions: { label: 'INCLUSIONS', items: ['Private chauffeur throughout', 'Boutique-only properties', 'First-class rail', 'Vineyard dining', 'Concierge in-country', 'Lifetime aftercare'] },
  },
  registration: {
    show: true, tag: 'APPLY', title: 'Apply To Travel',
    leadSubBrand: 'travelstall', tenantSlug: 'travel-stall',
    coversTitle: 'What the discovery call covers',
    coversIntro: 'A senior concierge spends 45 minutes shaping the journey to you.',
    covers: [
      { title: 'Your Travel Style', body: 'Pace, mealtimes, language preferences, photography interest.' },
      { title: 'Property Shortlist', body: 'Three to five chalets / hotels matched to your taste.' },
      { title: 'Routing Drafts', body: 'Two alternative itineraries within the budget.' },
      { title: 'Concierge Pairing', body: 'Meet the in-country concierge before booking.' },
    ],
  },
  faq: {
    show: true, tag: 'QUESTIONS', title: 'Frequently Asked',
    categories: [{ id: 'all', label: 'All', icon: '◇' }, { id: 'experience', label: 'Experience', icon: '◈' }, { id: 'investment', label: 'Investment', icon: '€' }],
    items: [
      { cat: 'experience', q: 'Is this a group tour?', a: 'No — every journey is private. You and your travel companion alone.' },
      { cat: 'experience', q: 'Can the itinerary be adjusted?', a: 'Always. The published itinerary is a starting point for a conversation.' },
      { cat: 'investment', q: 'Why an application fee?', a: 'It funds the discovery call. Refunded against booking.' },
    ],
  },
  finalCta: {
    show: true, eyebrow: 'PRIVATE COLLECTION', title: 'Travel That Belongs To You.', subtitle: 'Designed in conversation. Lived in stillness.',
    steps: [{ label: 'Apply' }, { label: 'Discovery call' }, { label: 'Travel together' }],
    ctaLabel: 'APPLY', ctaHref: '#register',
  },
  contact: {
    show: true, label: 'PRIVATE COLLECTION 2026', tagline: 'Curated. Quiet. Considered.',
    sections: [{ label: 'EMAIL', lines: ['private@travelstall.in'] }, { label: 'PHONE', lines: ['+91 80 1234 5678'] }],
    copyright: '© 2026 Travel Stall · Private Collection',
  },
  floatingCta: { show: true, text: 'APPLY', href: '#register' },
};

// ── Iceland — destination-agnostic proof: routes to luxury-alpine
// theme (same theme that handles Switzerland) without any new code.
const ICELAND = {
  brand: { label: 'PRIVATE COLLECTION · ICELAND', programmeName: 'Iceland — Fire & Ice', programmeTagline: 'A private exploration of the North Atlantic.' },
  nav: { links: [{ label: 'Experience', href: '#hero' }, { label: 'Curation', href: '#cultural' }, { label: 'Investment', href: '#investment' }, { label: 'FAQs', href: '#faqs' }], ctaText: 'Enquire', ctaHref: '#register' },
  hero: {
    eyebrow: { date: 'FEB-MAR 2026', audience: 'COUPLES · NORTHERN LIGHTS SEASON', batchPill: 'BY APPLICATION' },
    kicker: '8 Days. 5 Quiet Stops.',
    headline: 'Iceland — Where Silence Has A Geography.',
    lede: 'Reykjavik, the Golden Circle, Vík, Höfn, and the Eastfjords. Aurora chasing, glacier lagoons, hot-spring evenings — at the pace of one couple at a time.',
    benefitCards: [
      { icon: '✦', title: 'Private', desc: 'Just the two of you, all the way.' },
      { icon: '◈', title: 'Aurora-Optimised', desc: 'Itinerary timed to dark-sky windows.' },
      { icon: '◊', title: 'Land Rover', desc: 'Off-grid access where coaches cannot reach.' },
      { icon: '✧', title: 'Considered', desc: 'Each lodge inspected; menus pre-discussed.' },
    ],
    countdown: { label: 'AURORA-SEASON SLOTS CLOSE', deadlineIso: '2026-01-15T23:59:59+05:30', ctaText: 'Apply', ctaHref: '#register' },
    visualTitle: 'Iceland Private Collection 2026', visualSub: 'An 8-day curation across the North Atlantic.', posterAlt: 'Iceland luxury hero',
  },
  marquee: { cities: [{ tag: 'CAPITAL', title: 'Reykjavik' }, { tag: 'GOLDEN CIRCLE', title: 'Þingvellir' }, { tag: 'BLACK SAND', title: 'Vík' }, { tag: 'GLACIER LAGOON', title: 'Höfn' }, { tag: 'EASTFJORDS', title: 'Seyðisfjörður' }] },
  cultural: {
    show: true, tag: 'CURATION', title: 'Each Stop, A Memory.',
    items: [
      { id: 'reykjavik', icon: 'alps', name: 'Reykjavik', label: 'CAPITAL', body: ['A private city walk with a former curator, then a tasting menu at one of three reservation-only kitchens.'], benefit: 'The civilised entry.' },
      { id: 'thingvellir', icon: 'lake', name: 'Þingvellir', label: 'GOLDEN CIRCLE', body: ['The Mid-Atlantic rift, Geysir, Gullfoss waterfall — at first light, before the buses.'], benefit: 'Wonder, uncrowded.' },
      { id: 'vik', icon: 'chalet', name: 'Vík', label: 'BLACK SAND', body: ['Basalt sea stacks, the Reynisfjara beach, a chef-hosted dinner in a glass cabin facing the surf.'], benefit: 'Solitude as luxury.' },
      { id: 'hofn', icon: 'aurora', name: 'Höfn', label: 'GLACIER LAGOON', body: ['Jökulsárlón at sunrise, a zodiac among the icebergs, then the diamond beach at dusk.'], benefit: 'Scale beyond words.' },
      { id: 'seydisfjordur', icon: 'aurora', name: 'Seyðisfjörður', label: 'EASTFJORDS', body: ['A wooden church, a creative-residency lodge, aurora viewing from a private balcony.'], benefit: 'Stillness made visible.' },
    ],
  },
  investment: {
    show: true, tag: 'INVESTMENT', title: 'Investment', currency: '€',
    featuredIndex: 0, featuredBadge: 'START WITH A CALL',
    tiers: [
      { step: 1, title: 'Application Fee', subtitle: 'Discovery call', amount: '500', tag: 'Refundable on booking', date: 'On enquiry', vendor: 'Travel Stall Private' },
      { step: 2, title: 'Booking', subtitle: 'Reserve the journey', amount: '5,800', date: '60 days prior', vendor: 'Travel Stall Private' },
      { step: 3, title: 'Balance', subtitle: 'Final clearance', amount: '11,200', date: '14 days prior', vendor: 'Travel Stall Private' },
    ],
    inclusions: { label: 'INCLUSIONS', items: ['Private Land Rover with driver-guide', 'Boutique-only stays', 'Aurora-window optimisation', 'Glacier zodiac', 'In-country concierge', 'Lifetime aftercare'] },
  },
  registration: {
    show: true, tag: 'APPLY', title: 'Apply To Travel · Iceland',
    leadSubBrand: 'travelstall', tenantSlug: 'travel-stall',
    coversTitle: 'What the discovery call covers',
    coversIntro: 'A senior concierge spends 45 minutes shaping the journey to you.',
    covers: [
      { title: 'Aurora Strategy', body: 'KP-index analysis to maximise dark-sky probabilities.' },
      { title: 'Lodge Shortlist', body: 'Three to four glass-roof and boutique stays.' },
      { title: 'Driving Routes', body: 'Ring-road or fjord-focused alternatives.' },
      { title: 'Concierge Pairing', body: 'Meet the in-country guide before booking.' },
    ],
  },
  faq: {
    show: true, tag: 'QUESTIONS', title: 'Frequently Asked',
    categories: [{ id: 'all', label: 'All', icon: '◇' }, { id: 'experience', label: 'Experience', icon: '◈' }, { id: 'investment', label: 'Investment', icon: '€' }],
    items: [
      { cat: 'experience', q: 'Is aurora viewing guaranteed?', a: 'Nothing in nature is guaranteed. Our itinerary is timed to dark-sky windows and historically high KP-index nights to maximise the odds.' },
      { cat: 'experience', q: 'How private is "private"?', a: 'Just the two of you, your driver-guide, and the lodge staff. No other guests share your journey.' },
      { cat: 'investment', q: 'Why an application fee?', a: 'It funds the discovery call where we shape the journey to you. Refunded against booking.' },
    ],
  },
  finalCta: {
    show: true, eyebrow: 'PRIVATE COLLECTION · ICELAND', title: 'A Journey Where The Sky Performs.', subtitle: 'Aurora-timed, privately led, considered down to the meal.',
    steps: [{ label: 'Apply' }, { label: 'Discovery call' }, { label: 'Travel together' }],
    ctaLabel: 'APPLY', ctaHref: '#register',
  },
  contact: {
    show: true, label: 'PRIVATE COLLECTION · ICELAND', tagline: 'Where silence has a geography.',
    sections: [{ label: 'EMAIL', lines: ['private@travelstall.in'] }, { label: 'PHONE', lines: ['+91 80 1234 5678'] }],
    copyright: '© 2026 Travel Stall · Private Collection',
  },
  floatingCta: { show: true, text: 'APPLY', href: '#register' },
};

// ── Vietnam — destination-agnostic proof: routes to family-tropical
// theme (same theme that handles Bali) without any new code.
const VIETNAM = {
  brand: { label: 'VIETNAM FAMILY 2026', programmeName: 'Vietnam Family Holiday 2026', programmeTagline: 'A coastal-to-mountain family adventure.' },
  nav: { links: [{ label: 'Highlights', href: '#cultural' }, { label: 'Safety', href: '#safety' }, { label: 'Pricing', href: '#investment' }, { label: 'FAQs', href: '#faqs' }], ctaText: 'Book This Trip', ctaHref: '#register' },
  hero: {
    eyebrow: { date: 'OCT 2026', audience: 'FAMILY · 2 ADULTS + 2 KIDS', batchPill: 'School-holiday friendly' },
    kicker: '08 Days. 4 Regions.',
    headline: 'Vietnam — Coast, Caves, And Lantern Streets.',
    lede: 'Hanoi, Halong Bay, Hoi An, and Da Nang. Cave kayaking, lantern-lit dinners, beach days, and the world\'s best bánh mì — at family pace.',
    benefitCards: [
      { icon: '☀', title: 'Beach + Mountains', desc: 'Halong Bay + Hoi An old quarter.' },
      { icon: '🌴', title: 'Kid Activities', desc: 'Lantern-making, cooking class, cave kayak.' },
      { icon: '🍳', title: 'Easy Meals', desc: 'Pho, bánh mì, fresh fruit shakes daily.' },
      { icon: '📸', title: 'Photo-Rich', desc: 'Junks, lanterns, beach, terraces.' },
    ],
    countdown: { label: 'EARLY-BIRD CLOSES IN', deadlineIso: '2026-08-15T23:59:59+05:30', ctaText: 'Reserve This Trip', ctaHref: '#register' },
    visualTitle: 'Vietnam Family Holiday 2026', visualSub: 'A coast-and-mountain family adventure across four regions.', posterAlt: 'Vietnam family holiday hero',
  },
  marquee: { cities: [{ tag: 'CAPITAL', title: 'Hanoi' }, { tag: 'WORLD HERITAGE', title: 'Halong Bay' }, { tag: 'OLD QUARTER', title: 'Hoi An' }, { tag: 'BEACH', title: 'Da Nang' }] },
  cultural: {
    show: true, tag: "WHAT YOU'LL DO", title: 'Activities Built For Family Fun',
    items: [
      { id: 'hanoi', icon: 'temple', name: 'Hanoi', label: 'CAPITAL', body: ['Old quarter walk, water puppet show, Vietnamese coffee tasting.'], benefit: 'A capital that hums.' },
      { id: 'halong', icon: 'wave', name: 'Halong Bay', label: 'WORLD HERITAGE', body: ['Overnight junk cruise, cave kayak, sunrise tai-chi on deck.'], benefit: 'Geology meets serenity.' },
      { id: 'hoian', icon: 'palm', name: 'Hoi An', label: 'OLD QUARTER', body: ['Lantern-making workshop, family cooking class, riverside dinner.'], benefit: 'A city lit by lanterns.' },
      { id: 'danang', icon: 'boat', name: 'Da Nang', label: 'BEACH', body: ['My Khe beach days, Marble Mountain temples, family pool time.'], benefit: 'Rest after wonder.' },
    ],
  },
  safety: {
    show: true, title: 'Family Safe. Travel Easy.',
    subtitle: 'Kid-tested ratios and a parent hotline that always answers.',
    stats: [
      { stat: '1:8', title: 'Family Ratio', body: 'One coordinator for every 8 family members.' },
      { stat: '🛟', title: 'Junk Safety', body: 'Life jackets, supervision, family rooms on board.' },
      { stat: '24/7', title: 'Parent Hotline', body: 'India-based number, always answered.' },
      { stat: '🛂', title: 'Visa Handled', body: 'We sort the Vietnam e-visa for you.' },
    ],
    features: [
      { icon: 'shield', title: 'Kid-safe properties', desc: 'Inspected hotels, family rooms, pool fencing.' },
      { icon: 'briefcase', title: 'Health & wellness', desc: 'Registered nurse on tour + travel insurance.' },
      { icon: 'send', title: '24/7 support', desc: 'Round-the-clock parent contact line.' },
      { icon: 'package', title: 'Door-to-door', desc: 'Airport pickup to hotel drop, all transport sorted.' },
    ],
    included: { title: "What's Included", items: ['Return flights', 'All accommodation', 'All meals', 'Vietnam e-visa', 'Travel insurance', 'Private transport', 'Activities', 'Lantern + cooking class kits'] },
  },
  investment: {
    show: true, tag: 'TRANSPARENT PRICING', title: 'Family Holiday Pricing', currency: '₹',
    featuredIndex: 0, featuredBadge: 'BOOK FIRST',
    tiers: [
      { step: 1, title: 'Booking Fee', subtitle: 'Non-refundable', amount: '30,000', date: '20 Jun 2026', vendor: 'Travel Stall' },
      { step: 2, title: 'Balance', subtitle: 'Pre-departure', amount: '1,60,000', date: '20 Aug 2026', vendor: 'Travel Stall' },
    ],
    inclusions: { label: 'INDICATIVE INCLUSIONS', items: ['Airfare', 'Hotels (family rooms)', 'All meals', 'Junk cruise', 'Activities', 'Insurance'] },
  },
  registration: {
    show: true, tag: 'BOOK THIS TRIP', title: 'Hold Your Dates · Vietnam',
    leadSubBrand: 'travelstall', tenantSlug: 'travel-stall',
    coversTitle: 'What you get within 24 hours',
    coversIntro: 'A full plan to share with the whole family before deciding.',
    covers: [
      { title: 'Day-By-Day Plan', body: 'Hanoi → Halong → Hoi An → Da Nang itinerary.' },
      { title: 'Safety Brief', body: 'Junk-cruise safety + family-rooms inspection notes.' },
      { title: 'Activities Menu', body: 'Lantern-making, cooking classes, cave kayaks.' },
      { title: 'Cost Sheet', body: 'Transparent two-instalment breakdown.' },
    ],
  },
  faq: {
    show: true, tag: 'FAMILY QUESTIONS', title: 'Frequently Asked',
    categories: [{ id: 'all', label: 'All Questions', icon: '◇' }, { id: 'family', label: 'For Families', icon: '👨‍👩‍👧‍👦' }, { id: 'safety', label: 'Safety', icon: '🛡' }],
    items: [
      { cat: 'family', q: 'Is the junk cruise safe for kids?', a: 'Yes — life jackets, supervised activities, family rooms on board.' },
      { cat: 'family', q: 'Vegetarian options?', a: 'Yes — all meals offered with vegetarian alternatives; we pre-inform restaurants.' },
      { cat: 'safety', q: 'Visa process?', a: 'Vietnam e-visa — we handle the paperwork; you sign and pay.' },
    ],
  },
  finalCta: {
    show: true, eyebrow: '08 DAYS · 4 REGIONS', title: 'A Family Adventure Worth Bringing Home.', subtitle: 'Coast, caves, lanterns, and the best food in Asia.',
    steps: [{ label: 'Reserve dates' }, { label: 'Personalise activities' }, { label: 'Travel together' }],
    ctaLabel: 'BOOK THIS TRIP', ctaHref: '#register',
  },
  contact: {
    show: true, label: 'VIETNAM FAMILY 2026', tagline: 'Coast, caves, and lantern streets.',
    sections: [{ label: 'EMAIL', lines: ['family@travelstall.in'] }, { label: 'PHONE', lines: ['+91 90000 12345'] }],
    copyright: '© 2026 Travel Stall',
  },
  floatingCta: { show: true, text: 'BOOK THIS TRIP', href: '#register' },
};

// ── Render each + write to disk ─────────────────────────────────────

function renderAndWrite(templateModule, slug, payload, displayName, themeOverride) {
  const html = templateModule.render(
    {
      slug,
      title: payload.brand.programmeName,
      metaTitle: `${payload.brand.programmeName} — PR-E Phase 1.5 sample`,
      metaDescription: payload.brand.programmeTagline,
      content: JSON.stringify(payload),
    },
    themeOverride ? { theme: themeOverride, preview: true } : { preview: true }
  );
  const outPath = path.join(OUT_DIR, `${slug}.html`);
  fs.writeFileSync(outPath, html, 'utf8');
  console.log(`✓ ${displayName.padEnd(36)} → ${path.relative(process.cwd(), outPath)}  (${(html.length / 1024).toFixed(1)} KB)`);
}

if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

console.log('PR-E Phase 1.5 sample renders → ' + OUT_DIR);
console.log('');
console.log('Architecture proof:');
console.log('   - 4 family TEMPLATES (educational / religious / family / luxury)');
console.log('   - 13 family-generic THEME variants (no destination-named themes)');
console.log('   - 6 sample destinations route to them WITHOUT new template / theme / renderer code:');
console.log('');
// Originally-named destinations — re-render with the new family-generic themes.
renderAndWrite(educationalTripV1, 'japan',       JAPAN,       'Japan       → educational-academic');
renderAndWrite(familyTripV1,      'bali',        BALI,        'Bali        → family-tropical');
renderAndWrite(religiousTourV1,   'umrah',       UMRAH,       'Umrah       → religious-classical');
renderAndWrite(luxuryTourV1,      'switzerland', SWITZERLAND, 'Switzerland → luxury-alpine');
// New destinations — DESTINATION-AGNOSTIC PROOF: no new code needed.
renderAndWrite(luxuryTourV1,      'iceland',     ICELAND,     'Iceland     → luxury-alpine (same as Switzerland)');
renderAndWrite(familyTripV1,      'vietnam',     VIETNAM,     'Vietnam     → family-tropical (same as Bali)');
console.log('');
console.log('Open in browser:');
['japan', 'bali', 'umrah', 'switzerland', 'iceland', 'vietnam'].forEach((s) => {
  console.log('   start ' + path.join(OUT_DIR, `${s}.html`));
});
