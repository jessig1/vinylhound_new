import { LibraryPage } from "../library-page";

export const dynamic = "force-dynamic";

export default function WishlistPage() {
  return (
    <LibraryPage
      description="The records you're keeping an eye out for."
      list="wishlist"
      title="Your wishlist"
    />
  );
}
