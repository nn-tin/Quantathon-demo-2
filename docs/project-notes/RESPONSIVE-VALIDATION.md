# Responsive validation

The frontend ends with a responsive safety layer that preserves the desktop
composition and converts the application to a vertically scrollable,
single-column layout on narrow or short viewports. Wide 24-hour charts stay
inside their own scrollable cards rather than widening the page.

Target viewport classes include phones from 280 CSS pixels wide, tablets,
compact 1280×720 laptops, standard desktop displays and wide desktop displays.
No implementation can guarantee identical rendering on every browser/device,
but the layout avoids fixed-page horizontal overflow and inaccessible content
across these classes.
