import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import zhCN from './locales/zh-CN/common.json';
import en from './locales/en/common.json';

const savedLang = localStorage.getItem('ohmyagent_lang');
const browserLang = navigator.language.startsWith('zh') ? 'zh-CN' : 'en';

i18n.use(initReactI18next).init({
  resources: {
    'zh-CN': { common: zhCN },
    en: { common: en },
  },
  lng: savedLang || browserLang || 'zh-CN',
  fallbackLng: 'zh-CN',
  defaultNS: 'common',
  interpolation: {
    escapeValue: false,
  },
});

i18n.on('languageChanged', (lng) => {
  localStorage.setItem('ohmyagent_lang', lng);
});

export default i18n;
