import { LibraryPage } from "../library-page";

export const dynamic = "force-dynamic";

export default function WishlistPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  return (
    <LibraryPage
      description="The records you're keeping an eye out for."
      list="wishlist"
      searchParams={searchParams}
      title="Your wishlist"
    />
  );
}
