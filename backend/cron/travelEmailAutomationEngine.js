"use strict";

const cronRegistry = require("../lib/cronRegistry");
const { tickTravelEmailAutomation } = require("../lib/travelEmailAutomation");

function initTravelEmailAutomationCron() {
  cronRegistry.register({
    name: "travelEmailAutomation",
    description: "Travel CRM email sequence delivery — every minute",
    defaultSchedule: "* * * * *",
    tickFn: tickTravelEmailAutomation,
  }).catch((error) => console.error("[travelEmailAutomation] cron registration failed:", error.message));
}

module.exports = { initTravelEmailAutomationCron, tickTravelEmailAutomation };
