import { useTranslation } from "react-i18next";
import { ShortcutList } from "../../components/Shortcuts";
import { Card } from "../../components/ui";

/** Übersicht der Tastenkürzel (dieselbe Liste wie die Hilfe mit „?“). */
export function ShortcutsSection() {
  const { t } = useTranslation();
  return (
    <Card title={t("shortcuts.title")} description={t("shortcuts.description")}>
      <ShortcutList />
    </Card>
  );
}
