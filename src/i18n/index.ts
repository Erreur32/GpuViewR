import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from './locales/en.json';
import fr from './locales/fr.json';

// Add a new language by importing the JSON and adding it to `resources` below.
// Falls back to English when a key is missing.
const resources = {
  en: { translation: en },
  fr: { translation: fr },
};

const stored = typeof localStorage !== 'undefined' ? localStorage.getItem('gpuviewr.lang') : null;
const lang = stored || (typeof navigator !== 'undefined' && navigator.language?.startsWith('fr') ? 'fr' : 'en');

i18n.use(initReactI18next).init({
  resources,
  lng: lang,
  fallbackLng: 'en',
  interpolation: { escapeValue: false },
});

export const SUPPORTED_LANGS = Object.keys(resources);
export default i18n;
