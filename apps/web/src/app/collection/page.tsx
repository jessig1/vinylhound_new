import { LibraryPage } from "../library-page";

export const dynamic = "force-dynamic";

export default function CollectionPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  return (
    <LibraryPage
      description="Every record currently on your shelves."
      list="collection"
      searchParams={searchParams}
      title="Your collection"
    />
  );
}
