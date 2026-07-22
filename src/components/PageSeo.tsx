import { useEffect } from 'react';
import { SITE_URL } from '@/lib/company';

type PageSeoProps = {
  title: string;
  description?: string;
  path?: string;
  brand?: string;
  noindex?: boolean;
  ogImage?: string;
};

/** Lightweight document title / meta updater for SPA routes. */
export default function PageSeo({
  title,
  description,
  path = '/',
  noindex,
  ogImage,
}: PageSeoProps) {
  useEffect(() => {
    const fullTitle = title.includes('Tick3t') ? title : `${title} · Tick3t`;
    document.title = fullTitle;

    const setMeta = (attr: 'name' | 'property', key: string, content: string) => {
      let el = document.querySelector(`meta[${attr}="${key}"]`) as HTMLMetaElement | null;
      if (!el) {
        el = document.createElement('meta');
        el.setAttribute(attr, key);
        document.head.appendChild(el);
      }
      el.content = content;
    };

    if (description) setMeta('name', 'description', description);
    setMeta('property', 'og:title', fullTitle);
    if (description) setMeta('property', 'og:description', description);
    setMeta('property', 'og:url', `${SITE_URL}${path}`);
    if (ogImage) setMeta('property', 'og:image', ogImage);
    setMeta('name', 'robots', noindex ? 'noindex,nofollow' : 'index,follow');
  }, [title, description, path, noindex, ogImage]);

  return null;
}
