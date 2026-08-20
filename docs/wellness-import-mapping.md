# Wellness Import Mapping

Target tenant: `2`

This note maps the provided wellness export files to the current local Prisma
schema and wellness client concepts.

## Confirmed mappings

### `customers_dr._enhance_wellness_20260818_101020.xlsx` -> `Patient`

The source file is customer-labelled, but in the wellness client this belongs
to the patient directory.

Column mapping:

- `name` -> `Patient.name`
- `email` -> `Patient.email`
- `phone_number` -> `Patient.phone`
- `phone_number` normalized -> `Patient.normalizedPhone`
- `birth_date` -> `Patient.dob`
- `anniversary_date` -> `Patient.anniversary`
- `gender` (`Male`/`Female`/`Other`) -> `Patient.gender` (`M`/`F`/`Other`)
- `notes` -> `Patient.notes`
- `lead_source` -> `Patient.source`
- `instagram_handle` -> `Patient.instagramHandle`
- `tags` -> `Patient.tagsJson` as JSON array when present

Not currently mapped unless needed:

- `id` (external source id only)
- `sms_number`
- `code`
- `lead_source_other`

### `services_dr._enhance_wellness_20260818_101038.xlsx` -> `Service`

Column mapping:

- `service_name` -> `Service.name`
- `service_category` -> `ServiceCategory.name` and `Service.category`
- `duration_in_hhmm` -> `Service.durationMin`
- `description` -> `Service.description`
- `price` -> `Service.basePrice`
- `discounted_price` -> `Service.discountedPrice`
- `gender` -> `Service.gender`
- `code` -> `Service.code`
- `tax` -> `Service.tax`
- `is_home_service` -> `Service.isHomeService`
- `hide_price_from_customer` -> `Service.hidePriceFromCustomer`
- `is_starting_price` -> `Service.isStartingPrice`
- `is_tax_included` -> `Service.isTaxIncluded`
- `order` -> `Service.displayOrder`
- `image_urls` -> `Service.imageUrls` as JSON array
- `is_active` -> `Service.isActive`

Likely ignore for now:

- `allow_booking`
- `is_favorite`
- `is_featured`
- `image_names`
- `sac_code` unless GST/SAC is required on service import

### `service_categories_dr._enhance_wellness_20260818_102119.xlsx` -> `ServiceCategory`

Column mapping:

- `name` -> `ServiceCategory.name`
- `parent_name` -> `ServiceCategory.parentId` by name lookup
- `color` -> `ServiceCategory.color`
- `description` -> `ServiceCategory.description`
- `order` -> `ServiceCategory.displayOrder`
- `image_url` -> `ServiceCategory.imageUrl`

### `product_categories_dr._enhance_wellness_20260818_102144.xlsx` -> `ProductCategory`

Column mapping:

- `name` -> `ProductCategory.name`
- `image_url` -> `ProductCategory.imageUrl`
- `color` -> `ProductCategory.color`

Missing from export, so default/derive:

- `parentName` not present
- `active` default `true`

### `products_dr._enhance_wellness_20260818_101100.xlsx` -> `Product`

Column mapping:

- `product_name` -> `Product.name`
- `product_category` -> `ProductCategory.name` lookup -> `Product.categoryId`
- `brand_name` -> `Product.brandName`
- `product_type` -> `Product.productType`
- `product_code` -> `Product.productCode`
- `product_code` or blank -> `Product.sku` only if we choose to reuse it
- `hsn_code` -> `Product.hsnCode`
- `stock` -> `Product.currentStock`
- `volume` -> `Product.volume`
- `unit` -> `Product.unit`
- `sale_price` -> `Product.price`
- `discounted_price` -> `Product.discountedPrice`
- `dealer_price` -> `Product.dealerPrice`
- `purchase_price` -> `Product.purchasePrice`
- `manufacturer` -> `Product.manufacturer`
- `reorder_level` -> `Product.threshold`
- `tax` -> `Product.tax`
- `is_tax_included` -> `Product.isTaxIncluded`
- `barcode` -> `Product.barcode`
- first `image_urls` item -> `Product.imageUrl`

Not currently mapped unless needed:

- `id` (external source id only)
- `loose_qty`
- `image_names`

### `Auto_consumption.csv` -> `AutoConsumptionRule`

Column mapping:

- `Service Name` -> `Service.name` lookup -> `AutoConsumptionRule.serviceId`
- `Product ID` or `Product Name` -> `Product` lookup -> `AutoConsumptionRule.productId`
- `Quantity` -> `AutoConsumptionRule.quantityPerVisit`
- `Unit` -> `AutoConsumptionRule.unit`

Useful support fields from export:

- `Service ID`
- `Service Duration`
- `Service Price`
- `Product Price`

These are verification fields, not target columns.

### `drugs.csv` -> `Drug`

Column mapping:

- `Name` -> `Drug.name`
- `Strength` -> `Drug.strengthValue`
- `Strength Unit` -> `Drug.strengthUnit`
- `Preparation` -> `Drug.genericName` or `Drug.defaultDosage` depending on value quality
- `Route` -> may inform `Drug.defaultFrequency` or `Drug.notes`
- `Notes` -> `Drug.notes`

This file needs cleanup because early rows look like repeated header/template
content rather than real drugs.

## Likely custom-import files

### `bookings_2025-12-01_to_2026-08-18 (1).csv` -> `Visit`

Core mapping:

- `Customer Phone` -> `Patient` lookup -> `Visit.patientId`
- `Staff` -> `User` lookup -> `Visit.doctorId`
- `Items / Services` -> `Service` lookup -> `Visit.serviceId`
- `Date` + `Time` -> `Visit.visitDate`
- `Status` -> `Visit.status`
- `Total Amount` -> `Visit.amountCharged`
- `Booking Type` -> candidate for `Visit.bookingType`

Needs custom logic because:

- dates are `DD/MM/YYYY`
- time is a separate 12-hour field
- `Items / Services` can contain multiple or coded values
- payment status is separate from visit status

### `employees_dr._enhance_wellness_20260818_101259.xlsx` -> `User`

Core mapping:

- `name` -> `User.name`
- `email` -> `User.email`
- `phone_number` -> not currently on `User`
- `role` -> `User.role` and/or RBAC assignment
- `title` -> candidate for `User.specialty` or notes only
- `gender` -> no direct `User` column
- `notes` -> no direct `User` column

Needs explicit decisions for role mapping and password handling.

### `vendors.csv` -> `Vendor`

Column mapping:

- `Name` -> `Vendor.name`
- `Phone Number` -> `Vendor.phone`
- `GST Number` -> `Vendor.gstin`
- `Archived` -> `Vendor.isActive` inverted

### `inventory_receipts.csv` -> partial `InventoryReceipt`

The export is summary-level and does not include line-level `productId`,
`quantity`, or `unitCost` for each receipt row required by the model.

Possible use:

- derive/import vendors first
- retain invoice metadata for later manual reconciliation

### `Inventory_usage_2025-12-01_to_2026-08-18.csv` -> likely `SaleLineItem` and/or `ServiceConsumption`

Needs custom logic. This is transactional/reporting data rather than a direct
match to one current import surface.

### `prescriptions_2025-12-01_to_2026-08-18.csv` -> `Prescription`

Core mapping exists, but `Drugs` is embedded free text and needs parsing.

### `expenses.csv` -> `Expense`

Possible mapping:

- `Recipient` -> `Expense.title`
- `Description` -> `Expense.description`
- `Amount` -> `Expense.amount`
- `Category` -> `Expense.category`
- `Date` -> `Expense.expenseDate`
- `Created At` -> `Expense.createdAt` only for historical import if preserved

### `campaigns.csv` -> `Campaign`

Possible mapping:

- `Name` -> `Campaign.name`
- `Channel` -> `Campaign.channel`
- `Status` -> `Campaign.status`
- `Scheduled At` -> `Campaign.scheduledAt`
- `Created At` -> `Campaign.createdAt`
- `Sent` -> `Campaign.sent`

But the source has delivery/read/template metrics not fully mirrored by the
core model.

## Aggregate/report-only files

These are not primary import sources:

- `sales-by-customer_2025-12-01_to_2026-08-18.csv`
- `sales-by-product_2025-12-01_to_2026-08-18.csv`
- `sales-by-service_2025-12-01_to_2026-08-18.csv`
- `sales-by-service-category_2025-12-01_to_2026-08-18.csv`

## Recommended local import order

1. `service_categories`
2. `services`
3. `product_categories`
4. `products`
5. `auto_consumption`
6. `customers` as patients
7. `drugs`
8. custom scripts for bookings, employees, vendors, expenses, prescriptions, campaigns

## Ambiguities to confirm

Only ask when needed during transform:

- whether `product_code` should also be used as `sku`
- whether `lead_source_other` should append to `Patient.source` or go into notes
- whether `allow_booking` should be stored into `Service.supportedBookingTypes`
- whether employee imports should create active login users or staff placeholders only
