import { useTranslation } from "react-i18next";

export function NotFound() {
  const { t } = useTranslation();
  return (
    <div className="mx-auto max-w-md p-8 text-center">
      <h1 className="text-2xl font-semibold">{t("notFound.title")}</h1>
      <p className="hint">{t("notFound.text")}</p>
      <a className="link" href="/">{t("notFound.home")}</a>
    </div>
  );
}
