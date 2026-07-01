-- Fresh Web Check-in Test Data (FUTURE dates)

INSERT INTO WebCheckin
(tenantId, contactId, itineraryId, pnr, airlineCode, flightNumber, departureAt, passengerName, windowOpenAt, status, seatPref, mealPref, boardingPassUrl, deliveredAt, automationSkipped, createdAt, updatedAt)
VALUES

(1, 1, NULL, 'QA-PENDING-001', '6E', '6E-501', DATE_ADD(NOW(), INTERVAL 3 DAY), 'Rajesh Kumar', DATE_ADD(NOW(), INTERVAL 1 DAY), 'pending', '12A', 'veg', NULL, NULL, 0, NOW(), NOW()),
(1, 2, NULL, 'QA-PENDING-002', '6E', '6E-502', DATE_ADD(NOW(), INTERVAL 2 DAY), 'Priya Singh', DATE_ADD(NOW(), INTERVAL 12 HOUR), 'pending', '15F', 'non-veg', NULL, NULL, 0, NOW(), NOW()),
(1, 3, NULL, 'QA-PENDING-003', 'AI', 'AI-601', DATE_ADD(NOW(), INTERVAL 5 DAY), 'Amit Patel', DATE_ADD(NOW(), INTERVAL 3 DAY), 'pending', '1A', 'veg', NULL, NULL, 0, NOW(), NOW()),
(1, 1, NULL, 'QA-REMINDED-001', 'AI', 'AI-602', DATE_ADD(NOW(), INTERVAL 4 DAY), 'Rajesh Kumar', DATE_ADD(NOW(), INTERVAL 2 DAY), 'reminded', '8B', 'veg', NULL, NULL, 0, NOW(), NOW()),
(1, 2, NULL, 'QA-DONE-001', 'EK', 'EK-701', DATE_ADD(NOW(), INTERVAL 6 DAY), 'Priya Singh', DATE_ADD(NOW(), INTERVAL 4 DAY), 'done', '2C', 'halal', '/uploads/boarding-passes/stub-EK-QA-DONE-001.pdf', NULL, 0, NOW(), NOW()),
(1, 3, NULL, 'QA-DELIVERED-001', '6E', '6E-503', DATE_ADD(NOW(), INTERVAL 1 DAY), 'Amit Patel', DATE_ADD(NOW(), INTERVAL 12 HOUR), 'done', '18D', 'veg', '/uploads/boarding-passes/stub-6E-QA-DELIVERED-001.pdf', NOW(), 0, NOW(), NOW()),
(1, 1, NULL, 'QA-FALLBACK-001', 'AI', 'AI-603', DATE_ADD(NOW(), INTERVAL 7 DAY), 'Rajesh Kumar', DATE_ADD(NOW(), INTERVAL 5 DAY), 'fallback-agent', '5E', 'veg', NULL, NULL, 0, NOW(), NOW()),
(1, 2, NULL, 'QA-FALLBACK-002', 'EK', 'EK-702', DATE_ADD(NOW(), INTERVAL 8 DAY), 'Priya Singh', DATE_ADD(NOW(), INTERVAL 6 DAY), 'fallback-agent', '22F', 'veg', NULL, NULL, 0, NOW(), NOW()),
(1, 3, NULL, 'QA-SKIPPED-001', '6E', '6E-504', DATE_ADD(NOW(), INTERVAL 9 DAY), 'Amit Patel', DATE_ADD(NOW(), INTERVAL 7 DAY), 'pending', '10A', 'veg', NULL, NULL, 1, NOW(), NOW());

-- Insert automation runs
INSERT INTO WebCheckinAutomationRun
(tenantId, webCheckinId, airlineCode, outcome, errorMessage, boardingPassUrl, createdAt)
VALUES
(1, (SELECT id FROM WebCheckin WHERE pnr='QA-DONE-001' LIMIT 1), 'EK', 'success', NULL, '/uploads/boarding-passes/stub-EK-QA-DONE-001.pdf', NOW()),
(1, (SELECT id FROM WebCheckin WHERE pnr='QA-FALLBACK-001' LIMIT 1), 'AI', 'captcha', 'Captcha challenge presented', NULL, DATE_SUB(NOW(), INTERVAL 2 HOUR)),
(1, (SELECT id FROM WebCheckin WHERE pnr='QA-FALLBACK-002' LIMIT 1), 'EK', 'transient', 'Connection timeout', NULL, DATE_SUB(NOW(), INTERVAL 45 MINUTE)),
(1, (SELECT id FROM WebCheckin WHERE pnr='QA-FALLBACK-002' LIMIT 1), 'EK', 'transient', 'Connection timeout', NULL, DATE_SUB(NOW(), INTERVAL 30 MINUTE)),
(1, (SELECT id FROM WebCheckin WHERE pnr='QA-FALLBACK-002' LIMIT 1), 'EK', 'transient', 'Connection timeout', NULL, DATE_SUB(NOW(), INTERVAL 15 MINUTE));

-- Summary
SELECT '✅ QA Test Data Inserted!' AS Status;
SELECT COUNT(*) AS 'Total QA Records' FROM WebCheckin WHERE pnr LIKE 'QA-%';
SELECT status, COUNT(*) AS count FROM WebCheckin WHERE pnr LIKE 'QA-%' GROUP BY status;
SELECT airlineCode, COUNT(*) AS count FROM WebCheckin WHERE pnr LIKE 'QA-%' GROUP BY airlineCode;
