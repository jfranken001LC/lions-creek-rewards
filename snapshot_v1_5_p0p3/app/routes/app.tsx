import { data, Link, Outlet, useLoaderData } from "react-router";
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
    { label: "Dashboard", destination: "/app" },
    { label: "Settings", destination: "/app/settings" },
    { label: "Customers", destination: "/app/customers" },
    { label: "Redemptions", destination: "/app/redemptions" },
    { label: "Webhooks", destination: "/app/webhooks" },
    { label: "Reports", destination: "/app/reports" },
    { label: "Support", destination: "/app/support" },
  ];

  return (
    <ShopifyAppProvider embedded apiKey={apiKey}>
      <PolarisAppProvider i18n={enTranslations}>
        {NavMenu ? (
          <NavMenu>
            {/* rel="home" helps Shopify treat this as the app root in some contexts */}
            <Link to="/app" rel="home">
              Dashboard
            </Link>
            <Link to="/app/settings">Settings</Link>
            <Link to="/app/customers">Customers</Link>
            <Link to="/app/redemptions">Redemptions</Link>
            <Link to="/app/webhooks">Webhooks</Link>
            <Link to="/app/reports">Reports</Link>
            <Link to="/app/support">Support</Link>
          </NavMenu>
        ) : NavigationMenu ? (
          <NavigationMenu navigationLinks={navLinks} />
        ) : null}
        <Outlet />
      </PolarisAppProvider>
    </ShopifyAppProvider>
  );
}
