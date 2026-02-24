import { data, Link, Outlet, useLoaderData, useLocation } from "react-router";
import type { LoaderFunctionArgs } from "react-router";

import { AppProvider as ShopifyAppProvider } from "@shopify/shopify-app-react-router/react";
import { AppProvider as PolarisAppProvider } from "@shopify/polaris";
import enTranslations from "@shopify/polaris/locales/en.json";
import * as AppBridgeReact from "@shopify/app-bridge-react";

import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return data({ apiKey: process.env.SHOPIFY_API_KEY ?? "" });
};

export default function App() {
  const { apiKey } = useLoaderData<typeof loader>();

  const { search } = useLocation();
  const withSearch = (path: string) => (search ? `${path}${search}` : path);


  // App Bridge React has had breaking changes across major versions:
  // - Legacy: `NavigationMenu` component (props: navigationLinks)
  // - Current: `NavMenu` component (children anchors/Links)
  // This compatibility wrapper lets the app build on environments that have
  // either version installed, avoiding production-only build failures.
  const NavMenu = (AppBridgeReact as any).NavMenu as
    | undefined
    | React.ComponentType<{ children: React.ReactNode }>;
  const NavigationMenu = (AppBridgeReact as any).NavigationMenu as
    | undefined
    | React.ComponentType<{ navigationLinks: { label: string; destination: string }[] }>;

  const navLinks = [
    { label: "Dashboard", destination: withSearch("/app") },
    { label: "Settings", destination: withSearch("/app/settings") },
    { label: "Customers", destination: withSearch("/app/customers") },
    { label: "Redemptions", destination: withSearch("/app/redemptions") },
    { label: "Webhooks", destination: withSearch("/app/webhooks") },
    { label: "Reports", destination: withSearch("/app/reports") },
    { label: "Support", destination: withSearch("/app/support") },
  ];

  return (
    <ShopifyAppProvider embedded apiKey={apiKey}>
      <PolarisAppProvider i18n={enTranslations}>
        {NavMenu ? (
          <NavMenu>
            {/* rel="home" helps Shopify treat this as the app root in some contexts */}
            <Link to={withSearch("/app")} rel="home">
              Dashboard
            </Link>
            <Link to={withSearch("/app/settings")}>Settings</Link>
            <Link to={withSearch("/app/customers")}>Customers</Link>
            <Link to={withSearch("/app/redemptions")}>Redemptions</Link>
            <Link to={withSearch("/app/webhooks")}>Webhooks</Link>
            <Link to={withSearch("/app/reports")}>Reports</Link>
            <Link to={withSearch("/app/support")}>Support</Link>
          </NavMenu>
        ) : NavigationMenu ? (
          <NavigationMenu navigationLinks={navLinks} />
        ) : null}
        <Outlet />
      </PolarisAppProvider>
    </ShopifyAppProvider>
  );
}
