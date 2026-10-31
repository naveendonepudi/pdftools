import './style.css';
import { App, MOD } from './app';
import { hydrateIcons } from './ui/icons';

hydrateIcons();

// Show the right shortcut modifier in tooltips on non-Apple platforms.
if (MOD !== '⌘') {
  document.querySelectorAll<HTMLElement>('[title*="⌘"]').forEach((el) => {
    el.title = el.title.replace('⇧⌘', 'Ctrl+Shift+').replace('⌘', 'Ctrl+');
  });
}

new App();
