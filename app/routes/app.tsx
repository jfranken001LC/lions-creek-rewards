import { data, Outlet, useLoaderData } from "react-router";
import type { LoaderFunctionArgs } from "react-router";

import { AppProvider as ShopifyAppProvider } from "@shopify/shopify-app-react-router/react";
import { AppProvider as PolarisAppProvider } from "@shopify/polaris";
import enTranslations from "@shopify/polaris/locales/en.json";
import { NavigationMenu } from "@shopify/app-bridge-react";

import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return data({ apiKey: process.env.SHOPIFY_API_KEY ?? "" });
};

export default function App() {
  const { apiKey } = useLoaderData<typeof loader>();

  return (
    <ShopifyAppProvider embedded apiKey={apiKey}>
      <PolarisAppProvider i18n={enTranslations}>
        <NavigationMenu
          navigationLinks={[
            { label: "Dashboard", destination: "/app" },
            { label: "Settings", destination: "/app/settings" },
            { label: "Customers", destination: "/app/customers" },
            { label: "Redemptions", destination: "/app/redemptions" },
            { label: "Webhooks", destination: "/app/webhooks" },
            { label: "Reports", destination: "/app/reports" },
            { label: "Support", destination: "/app/support" },
          ]}
        />
        <Outlet />
      </PolarisAppProvider>
    </ShopifyAppProvider>
  );
}
