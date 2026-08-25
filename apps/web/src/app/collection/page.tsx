import { collection } from "../data";
import { LibraryPage } from "../library-page";

export default function CollectionPage() {
  return (
    <LibraryPage
      albums={collection}
      description="Every record currently on your shelves."
      title="Your collection"
    />
  );
}
