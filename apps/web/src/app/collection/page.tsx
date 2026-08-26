import { LibraryPage } from "../library-page";

export const dynamic = "force-dynamic";

export default function CollectionPage() {
  return (
    <LibraryPage
      description="Every record currently on your shelves."
      list="collection"
      title="Your collection"
    />
  );
}
