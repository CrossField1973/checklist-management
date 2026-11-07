import { useTranslation } from "react-i18next";
import { Card } from "../../components/ui";
import { TagManager } from "../templates/TagManager";

/** Tags umbenennen, einfärben, löschen und anlegen (direkt im Profil, ohne Zwischenschritt). */
export function TagsSection() {
  const { t } = useTranslation();
  return (
    <Card title={t("profile.tags.title")} description={t("profile.tags.description")}>
      <TagManager />
    </Card>
  );
}
