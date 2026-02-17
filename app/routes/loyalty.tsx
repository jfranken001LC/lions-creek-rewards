import type { LoaderFunctionArgs } from "react-router";
import { Form, Link, Outlet, data, useLoaderData } from "react-router";
import {
  Page,
  Card,
  BlockStack,
  InlineStack,
  Text,
  Button,
  Badge,
} from "@shopify/polaris";
import { verifyAppProxy } from "../lib/proxy.server";
import { computeCustomerLoyalty } from "../lib/loyalty.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const proxy = await verifyAppProxy(request);

  const customerId = proxy.customerId;
  if (!customerId) {
    return data({ ok: false, error: "Missing customer" }, { status: 400 });
  }

  const shop = proxy.shop;
  const loyalty = await computeCustomerLoyalty({ shop, customerId });

  return data({
    ok: true,
    customerId,
    shop,
    loyalty,
  });
}

export default function LoyaltyPage() {
  const result = useLoaderData<typeof loader>();

  if (!result.ok) {
    return (
      <Page title="Loyalty">
        <Card>
          <Text as="p" tone="critical">
            {result.error}
          </Text>
        </Card>
      </Page>
    );
  }

  const { customerId, loyalty } = result;

  return (
    <Page title="Loyalty">
      <BlockStack gap="400">
        <Card>
          <BlockStack gap="200">
            <Text as="h2" variant="headingMd">
              Customer
            </Text>
            <Text as="p">ID: {customerId}</Text>
          </BlockStack>
        </Card>

        <Card>
          <BlockStack gap="200">
            <Text as="h2" variant="headingMd">
              Points
            </Text>

            <InlineStack gap="200" align="start" blockAlign="center">
              <Text as="span">Balance:</Text>
              <Badge tone="success">{loyalty.pointsBalance}</Badge>
            </InlineStack>

            <Text as="p" tone="subdued">
              Lifetime earned: {loyalty.lifetimeEarned} • Lifetime redeemed:{" "}
              {loyalty.lifetimeRedeemed}
            </Text>

            <InlineStack gap="200">
              <Button
                url={`/apps/${encodeURIComponent("lions-creek-rewards")}/app`}
                variant="secondary"
              >
                Admin dashboard
              </Button>

              <Link to="/loyalty.json">Raw JSON</Link>
            </InlineStack>
          </BlockStack>
        </Card>

        <Card>
          <BlockStack gap="200">
            <Text as="h2" variant="headingMd">
              Redeem (example)
            </Text>
            <Text as="p" tone="subdued">
              This form is just a placeholder. Your real redeem flow is via your
              storefront UI calling the redeem endpoint.
            </Text>

            <Form method="post" action="/api/customer/redeem">
              <InlineStack gap="200">
                <Button submit variant="primary">
                  Redeem sample
                </Button>
              </InlineStack>
            </Form>
          </BlockStack>
        </Card>

        <Outlet />
      </BlockStack>
    </Page>
  );
}
