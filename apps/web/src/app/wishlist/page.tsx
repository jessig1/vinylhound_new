import { wishlist } from "../data";
import { LibraryPage } from "../library-page";

export default function WishlistPage() {
  return (
    <LibraryPage
      albums={wishlist}
      description="The records you’re keeping an eye out for."
      title="Your wishlist"
      wishlist
    />
  );
}
