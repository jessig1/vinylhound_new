import { DeleteAccountResponseSchema } from "@vinylhound/contracts";
import { deleteAccount } from "@vinylhound/database";

import { requireUserId } from "@/server/auth";
import { getServerContext } from "@/server/context";
import { jsonResponse, withRoute } from "@/server/http";

export const runtime = "nodejs";

export const DELETE = withRoute(
  "account.delete",
  async (_request, { requestId }) => {
    const context = getServerContext();
    const userId = await requireUserId(context);

    const result = await deleteAccount(context.database.db, { userId });

    await Promise.all(
      result.objectKeys.map(async (objectKey) => {
        try {
          await context.storage.deleteObject(objectKey);
        } catch (error) {
          console.error(
            `[web] failed to delete object during account deletion; requestId=${requestId} objectKey=${objectKey}`,
            error,
          );
        }
      }),
    );

    const response = jsonResponse(
      DeleteAccountResponseSchema.parse({ id: result.id }),
      200,
      requestId,
    );
    response.headers.set("cache-control", "no-store");
    return response;
  },
);
