import { h } from 'vue';
import DefaultTheme from 'vitepress/theme';
import type { Theme } from 'vitepress';
import HeroTerminal from './hero-terminal.vue';
import DataJourney from './data-journey.vue';
import './custom.css';

// "ATLAS BY WISECOM" in 8-bit ASCII, repeated; the home page section spacer.
const BITS = [...'ATLAS BY WISECOM ']
  .map((c) => c.charCodeAt(0).toString(2).padStart(8, '0'))
  .join(' ');
const WcBits = () => h('div', { class: 'wc-bits', 'aria-hidden': 'true' }, `${BITS} ${BITS}`);

const theme: Theme = {
  extends: DefaultTheme,
  enhanceApp({ app }) {
    app.component('WcBits', WcBits);
    app.component('DataJourney', DataJourney);
    app.component('CliTerminal', HeroTerminal);
  },
  Layout: () =>
    h(DefaultTheme.Layout, null, {
      'home-hero-image': () => h(HeroTerminal),
      'home-features-before': () => h(WcBits),
    }),
};

export default theme;
