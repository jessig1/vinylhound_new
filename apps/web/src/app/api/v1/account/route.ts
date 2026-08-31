import { DeleteAccountResponseSchema } from "@vinylhound/contracts";
import { deleteAccount } from "@vinylhound/database";

import { requireUserId } from "@/server/auth";
import { getServerContext } from "@/server/context";
import { createRequestId, errorResponse, jsonResponse } from "@/server/http";

export const runtime = "nodejs";

export async function DELETE() {
  const requestId = createRequestId();
  try {
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
  } catch (error) {
    return errorResponse(error, requestId);
  }
}
