import type { Route } from "./+types/root";
import {
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
} from "react-router";

import polarisStyles from "@shopify/polaris/build/esm/styles.css?url";

export const links = () => [
  { rel: "stylesheet", href: polarisStyles },
];

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        <Meta />
        <Links />
      </head>
      <body>
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function App() {
  return <Outlet />;
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  return (
    <html lang="en">
      <head>
        <title>Oops!</title>
        <Meta />
        <Links />
      </head>
      <body>
        <h1>App Error</h1>
        <pre style={{ whiteSpace: "pre-wrap" }}>
          {error?.message ?? String(error)}
        </pre>
        <Scripts />
      </body>
    </html>
  );
}
