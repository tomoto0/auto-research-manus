# Visual validation findings

Source: `/home/ubuntu/webdev-static-assets/auto-research-validation/real-dta-validation-paper.pdf`, pages 1-6 viewed after run `validation-dta-1777642847458`.

The PDF renders successfully with 10 embedded PNG charts and no obvious mojibake in titles, axes, legends, or captions. The charts are readable overall, and the category comparison, distribution, trend, density, stacked bar, horizontal bar, and residual plots appear intact.

One remaining quality issue was observed on page 4: the grouped multi-variable bar chart legend becomes crowded and partially overlaps because several long variable names are placed in a single horizontal legend row. The next implementation step should improve SVG/PNG legend wrapping or move multi-series legends into separate rows to prevent label overlap.

## Follow-up visual check after latest run

Source: `/home/ubuntu/webdev-static-assets/auto-research-validation/real-dta-validation-paper.pdf`, pages 1-6 viewed after run `validation-dta-1777643137134`.

The regenerated validation PDF still renders successfully with 10 embedded PNG charts. Main text, captions, axis labels, and most legends are readable, and no mojibake was observed in the English/transliterated labels. The figures are non-empty and correspond to the latest artifact validation output.

Remaining issue: Figure 6 (`grouped_bar_multivar`) still has a bottom legend overlap around the x-axis label because multiple long series labels are compressed into the same legend area. The next implementation step is to further reduce legend density for multi-series charts by moving legends farther below the plot with reserved bottom padding, using one legend item per row, or omitting the legend when each series is already distinguishable in context.

## Latest visual check after legend bottom-padding change

Source: `/home/ubuntu/webdev-static-assets/auto-research-validation/real-dta-validation-paper.pdf`, pages 1-4 viewed after rerun `validation-dta-1777643345861` and artifact validation. Pages 1-3 are readable, with English/ASCII chart labels and no mojibake. Page 4 still shows residual overlap in `grouped_bar_multivar`: the bottom legend and x-axis label crowd together, especially around `k_hiqual_dv` and the second-row legend entries. Additional chart-renderer-side legend layout or legend suppression for dense multi-series charts is required before final checkpoint.

## Latest visual inspection after dense-legend fix

Source: `/home/ubuntu/webdev-static-assets/auto-research-validation/real-dta-validation-paper.pdf`, pages 1–4 viewed after regenerating the PDF from run `validation-dta-1777643676526`.

Pages 1–4 render without garbled characters. The first six figures are visible, labels are readable, and the previously overlapping dense legend under the grouped multivariate bar chart is no longer drawn over the x-axis or caption. The grouped bar chart now relies on its title and caption instead of a dense legend, which is preferable to unreadable overlap for compact PDF embedding. Remaining pages still need one final visual pass before checkpoint.

## Final visual inspection of remaining pages

Source: `/home/ubuntu/webdev-static-assets/auto-research-validation/real-dta-validation-paper.pdf`, pages 5–6 viewed after run `validation-dta-1777643676526`.

Pages 5–6 render without mojibake. Density, stacked bar, horizontal bar, and residual-vs-fitted figures are visible and readable. Legends no longer overlap captions or axis labels in a blocking way. The visual validation therefore passes for the regenerated six-page PDF, with the caveat that very compact embedded charts remain small by nature of PDF layout but are readable.
