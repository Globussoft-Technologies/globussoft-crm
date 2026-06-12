# What We Need From You — Travel CRM

**For:** Yasin / Travel Stall
**Date:** 9 June 2026

Your travel software is **mostly built and working**. To switch on the remaining features, we need a few things from your side. Most are simply **logins to services you already use**, a handful of **decisions only you can make**, and some **material from your team** (like your logos and prices).

Nothing here is urgent-or-broken — the system runs today on safe "demo" placeholders. Each item below just turns a placeholder into the real thing. We've grouped them and explained **why each one matters**, in plain language.

> 🔴 = needed first (unlocks the most) 🟡 = soon 🟢 = can wait

---

## Part 1 — Logins & accounts (so the software can talk to your other services)

These are accounts/keys you (or your vendors) already have. Sending them lets the system do its job automatically instead of showing sample data.

| # | What we need | Why it matters | What to send us |
|---|---|---|---|
| 🔴 1 | **WhatsApp Business account** (Wati or Meta) | So the system can **automatically message your customers** — booking confirmations, payment reminders, OTP codes, itineraries, check-in alerts. Right now these are written but not sending. | Your Wati account number + API key **and** the WhatsApp phone number for each brand (TMC, RFU, ops). |
| 🔴 2 | **Your brand kit** (logos, colours, fonts) for each brand | So **every quote, invoice, report, email and the app itself look like your brands** (TMC / RFU / Travel Stall / Visa Sure) — not plain/unbranded. This is the single biggest "make it look real" item. | Logo files (high-res), your colour codes, fonts, and a letterhead — for each of the 4 brands. |
| 🔴 3 | **Hotel supplier login (RateHawk)** | So staff see **live, real hotel prices** when building Umrah/holiday quotes, instead of sample prices. | Your RateHawk API key + account ID. |
| 🟡 4 | **AI provider keys** (the companies that power the "smart" features) | So features like lead summaries, suggested itineraries and call talking-points show **real AI output** instead of demo text. | The API keys for OpenAI, Anthropic (Claude), Google AI, and Perplexity. (You hold these accounts.) |
| 🟡 5 | **AI-calling account (Callified)** | So the system can **auto-call and qualify new leads** in Hindi/English/Urdu and attach a summary to the lead. | Callified account access + the call script / "personality" you want for each brand. |
| 🟡 6 | **Ads-reporting account (AdsGPT)** | So your **marketing dashboard shows real ad spend, leads, and cost-per-lead** for each platform (Instagram, Facebook, etc.). | AdsGPT access + your ad-account IDs for each platform. |
| 🟡 7 | **DigiLocker partner login** | So parents/pilgrims can **verify Aadhaar the safe, legal way** (no risky photo uploads). | Your DigiLocker partner ID + secret key. |
| 🟢 8 | **Your accounting software details** (Excel Software for Travel) | So invoices **flow automatically into your accountant's system** — no manual re-entry. | Their technical documentation + one sample export file + a test login. |
| 🟢 9 | **Saudi ground-transport & train partners** (Zikr Cabs, Haramain train) | So RFU Umrah quotes can include **real cab and high-speed-train prices**. | Vendor sign-up + keys. (Note: the cab partner has a ~SAR 5,000 setup fee — worth starting early.) |
| 🟢 10 | **Booking.com partner account** | An **extra source of hotel inventory** alongside RateHawk. | Affiliate ID + keys. (Their approval takes a few weeks — best to start now.) |

---

## Part 2 — Decisions only you can make

These are short choices. We've given our recommendation in **bold** — you can just say "go with your recommendation" or pick the other option. We can't build these features correctly until you decide, because the choice changes how we build them.

| # | The question | Our recommendation | Why we're asking |
|---|---|---|---|
| 🟡 A | **Sub-agent & corporate portal** — do you want a separate login area for sub-agents and corporate clients (with commissions, approvals, travel policies)? If yes, how are commissions and approvals handled? | Confirm if this is in scope now or later | This is a large module; we shouldn't start until you confirm you want it and tell us your commission % and approval rules. |
| 🟡 B | **Marketing flyer designer** — use a **ready-made design tool** (faster to launch, small monthly fee) or build our own from scratch (slower, no fee)? | **Ready-made tool** | Saves weeks of work. We just need your yes on the small recurring cost. |
| 🟡 C | **Saudi hotel websites (5 of them)** — for each, do we have an **official partner login**, or should we read the public prices from their site? | Tell us per site | Determines whether we connect officially or read public pages — affects what's allowed and how reliable it is. |
| 🟢 D | **Automatic airline web check-in** — which airlines first? And are you OK to proceed **once our lawyer confirms** each airline's terms allow it? | **IndiGo, Air India, Vistara, Emirates first** | We auto-check-in passengers; we need your airline priority and a legal green-light. |
| 🟢 E | **Flight-quote browser tool** — who owns the Google Chrome store account it's published under (you or us)? Which airlines first? | We can host it privately for you | Needed before we publish the staff browser plug-in. |
| 🟢 F | **Supplier purchase orders** — how should a purchase order to a supplier be approved, and who signs off? | Quick call to map your process | We build the approval steps to match how you actually work. |

---

## Part 3 — Material from your team

These are things only your team has — text, prices, and data. The software has the "shelves" ready; we just need you to put your content on them.

| # | What we need | Why it matters |
|---|---|---|
| 🔴 1 | **TMC curriculum content** — the "what your students will gain" write-up for each of your 5 starter trips, mapped to school boards (CBSE/IB/IGCSE). | The school readiness report can't make credible curriculum claims without your academic team's wording. This blocks the TMC school-trip launch. |
| 🟡 2 | **Your GST details** — GST numbers for each brand, your state, sample of how your accountant wants the tax export, and your tax/HSN codes. | So invoices are tax-correct and filing-ready for your accountant. |
| 🟡 3 | **Visa Sure setup** — the 15 readiness questions + how you score them, and the document checklist for each visa type. | So the Visa Sure section can go live with your actual process. |
| 🟢 4 | **Test users** — a few people per brand to try the system before go-live. | So we can do a proper trial run (UAT) before launch. |

---

## Part 4 — One lawyer session

A single ~30–45 minute call with your lawyer to approve the wording for a few legally-sensitive things. We'll send drafts in advance so it's quick.

1. **Aadhaar consent text** — the message customers agree to before Aadhaar verification.
2. **"This call may be recorded / is automated"** announcement for AI calls (required by Indian telecom rules).
3. **Passport-photo consent** wording.
4. **Permission to use the airline and hotel websites** for automatic check-in and price look-ups.

---

## The short version

If you can send us **just the first 3 items in Part 1** (WhatsApp account, your brand kit, and the RateHawk hotel login) and answer **decisions A and B in Part 2**, that alone switches on the largest share of the remaining features. Everything else can follow at a comfortable pace.

We're happy to hop on a call and collect most of these together if that's easier.

---

*(There is a detailed technical version of this list for our engineering team at `TRAVEL_CRM_CLIENT_REQUIREMENTS.md` — this document is the plain-language summary.)*
