# Lions Creek Rewards v1.12.6 remediation summary

## Focus of this pass
- Reviewed end-user UI surfaces: customer account rewards page, footer navigation, cart redemption block, Thank you block, and Order status block.
- Removed the merchant-facing requirement to manually enter an App Base URL for JS UI extensions.
- Clarified onboarding so setup reflects what a merchant actually must do inside Shopify.
- Added a grouped editor extension collection to make checkout/accounts placement easier.
- Improved cart redemption error messaging so shoppers see inline feedback instead of browser alerts.

## Code changes included
1. **Customer account / Thank you / Order status base URL handling**
   - JS UI extensions now resolve the backend origin from the active app environment first.
   - Legacy extension settings remain a fallback in source for backwards compatibility with older installs.
   - Merchant-facing `app_base_url` settings were removed from extension TOML files.

2. **Getting started flow**
   - Replaced the old “set App Base URL” instruction with one-time placement steps for customer account, Thank you, Order status, and cart surfaces.
   - Added explicit mention that the JS UI extensions follow the active environment automatically.

3. **Editor collection**
   - Added `extensions/lcr-rewards-editor-collection/shopify.extension.toml` so customer account and checkout surfaces can be grouped together in the checkout/accounts editor.

4. **Cart UX**
   - Replaced shopper-facing `alert()` calls with inline status messages.

## Shopify platform finding
- Checkout/customer-account UI surfaces still require merchant placement and save in the checkout/accounts editor.
- Theme cart app blocks still require merchant placement in the theme editor.
- The app can accelerate setup with editor collections, deep links, and activation-status checks, but not silently place those surfaces for the merchant.
