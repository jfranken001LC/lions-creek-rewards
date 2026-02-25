import '@shopify/ui-extensions';

//@ts-ignore
declare module './src/index.tsx' {
  const shopify: import('@shopify/ui-extensions/customer-account.footer.render-after').Api;
  const globalThis: { shopify: typeof shopify };
}
