import type { Route } from "./+types/root";
import { isRouteErrorResponse, useRouteError } from "react-router";

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


export function ErrorBoundary() {
  const error = useRouteError();

  if (isRouteErrorResponse(error)) {
    return (
      <Page>
        <h1>App Error</h1>
        <p>
          {error.status} {error.statusText}
        </p>
        {"data" in error && error.data ? (
          <pre style={{ whiteSpace: "pre-wrap" }}>
            {typeof error.data === "string" ? error.data : JSON.stringify(error.data, null, 2)}
          </pre>
        ) : null}
      </Page>
    );
  }

  const message = error instanceof Error ? error.message : JSON.stringify(error, null, 2);

  return (
    <Page>
      <h1>App Error</h1>
      <pre style={{ whiteSpace: "pre-wrap" }}>{message}</pre>
    </Page>
  );
}

