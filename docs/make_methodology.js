const {
  Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType,
  Table, TableRow, TableCell, WidthType, BorderStyle, ShadingType,
  LevelFormat, PageBreak, TableOfContents, convertInchesToTwip,
} = require("docx");
const fs = require("fs");

const NAVY = "1F3864";
const GRAY = "666666";
const LIGHT = "D9E2F3";

const p = (text, opts = {}) =>
  new Paragraph({
    spacing: { after: 160, line: 276 },
    ...opts.para,
    children: [new TextRun({ text, size: 22, font: "Calibri", ...opts.run })],
  });

const bullet = (text, opts = {}) =>
  new Paragraph({
    numbering: { reference: "bullets", level: 0 },
    spacing: { after: 80, line: 276 },
    children: [new TextRun({ text, size: 22, font: "Calibri", ...opts.run })],
  });

const bulletBold = (lead, rest) =>
  new Paragraph({
    numbering: { reference: "bullets", level: 0 },
    spacing: { after: 80, line: 276 },
    children: [
      new TextRun({ text: lead, bold: true, size: 22, font: "Calibri" }),
      new TextRun({ text: rest, size: 22, font: "Calibri" }),
    ],
  });

const h1 = (text) =>
  new Paragraph({
    heading: HeadingLevel.HEADING_1,
    spacing: { before: 360, after: 200 },
    children: [new TextRun({ text, size: 30, bold: true, color: NAVY, font: "Calibri" })],
  });

const h2 = (text) =>
  new Paragraph({
    heading: HeadingLevel.HEADING_2,
    spacing: { before: 280, after: 160 },
    children: [new TextRun({ text, size: 25, bold: true, color: NAVY, font: "Calibri" })],
  });

// ---- table helpers (DXA widths everywhere) ----
const TABLE_W = 9360; // 6.5" content width
function makeTable(headers, rows, colWidths) {
  const widths = colWidths.map((f) => Math.round(TABLE_W * f));
  const cell = (text, { bold = false, shade = null } = {}) =>
    new TableCell({
      width: { size: 0, type: WidthType.AUTO }, // placeholder, set below
      shading: shade ? { type: ShadingType.CLEAR, fill: shade } : undefined,
      margins: { top: 60, bottom: 60, left: 100, right: 100 },
      children: [
        new Paragraph({
          spacing: { after: 0 },
          children: [new TextRun({ text, bold, size: 20, font: "Calibri" })],
        }),
      ],
    });
  const headerRow = new TableRow({
    tableHeader: true,
    children: headers.map((hText, i) => {
      const c = cell(hText, { bold: true, shade: LIGHT });
      c.options ??= {};
      return new TableCell({
        width: { size: widths[i], type: WidthType.DXA },
        shading: { type: ShadingType.CLEAR, fill: LIGHT },
        margins: { top: 60, bottom: 60, left: 100, right: 100 },
        children: [
          new Paragraph({
            spacing: { after: 0 },
            children: [new TextRun({ text: hText, bold: true, size: 20, font: "Calibri" })],
          }),
        ],
      });
    }),
  });
  const bodyRows = rows.map(
    (r) =>
      new TableRow({
        children: r.map(
          (t, i) =>
            new TableCell({
              width: { size: widths[i], type: WidthType.DXA },
              margins: { top: 60, bottom: 60, left: 100, right: 100 },
              children: [
                new Paragraph({
                  spacing: { after: 0 },
                  children: [new TextRun({ text: t, size: 20, font: "Calibri" })],
                }),
              ],
            })
        ),
      })
  );
  return new Table({
    width: { size: TABLE_W, type: WidthType.DXA },
    columnWidths: widths,
    rows: [headerRow, ...bodyRows],
  });
}

const children = [];

// ================= TITLE =================
children.push(
  new Paragraph({
    spacing: { before: 2400, after: 120 },
    alignment: AlignmentType.CENTER,
    children: [new TextRun({ text: "MIM Stochastic Real Estate Model", bold: true, size: 52, color: NAVY, font: "Calibri" })],
  }),
  new Paragraph({
    spacing: { after: 480 },
    alignment: AlignmentType.CENTER,
    children: [new TextRun({ text: "Methodology Overview", size: 34, color: GRAY, font: "Calibri" })],
  }),
  new Paragraph({
    spacing: { after: 80 },
    alignment: AlignmentType.CENTER,
    children: [new TextRun({ text: "MetLife Investment Management", size: 24, font: "Calibri" })],
  }),
  new Paragraph({
    spacing: { after: 80 },
    alignment: AlignmentType.CENTER,
    children: [new TextRun({ text: "Real Estate Research & Strategy", size: 24, font: "Calibri" })],
  }),
  new Paragraph({
    spacing: { after: 2400 },
    alignment: AlignmentType.CENTER,
    children: [new TextRun({ text: "July 2026  •  Model version: sm_python (July 2026 recalibration)", size: 20, color: GRAY, font: "Calibri" })],
  }),
  new Paragraph({ children: [new PageBreak()] })
);

// ================= 1. EXECUTIVE SUMMARY =================
children.push(
  h1("1. Executive Summary"),
  p("The MIM Stochastic Real Estate Model is a scenario engine for comparing risk and return across commercial real estate property sectors. For each of 21 property sectors, the model simulates 10,000 plausible ten-year futures for a representative stabilized asset — each future with its own path of revenue, expenses, capital expenditures, and cap rates — and measures what those futures imply for two audiences:"),
  bulletBold("Equity: ", "the full distribution of unlevered ten-year returns (IRR), not just a single base case — including how wide the range of outcomes is, how skewed it is toward downside or upside, and the probability of falling short of a return hurdle."),
  bulletBold("Credit: ", "for a senior mortgage sized at current market terms, the probability of default, the loss if default occurs, and the resulting expected credit loss — expressed in basis points per year and mapped to a rating-agency-style letter grade."),
  p("The central idea is simple: a single-scenario pro forma tells you what happens if assumptions come true; this model tells you what happens across the realistic range of ways they might not. Two sectors with identical expected returns can carry very different risk, and that difference is exactly what the simulation surfaces."),
  p("The credit component was recalibrated in July 2026 against published historical loss data for U.S. commercial mortgages (Fitch, KBRA, Moody’s, and NAIC sources), and captures both ways a mortgage actually fails: default during the term (cash flow stops covering debt service) and default at maturity (the property is worth too little to refinance the balloon). Annual expected credit losses range from roughly 8 basis points per year for the most stable sectors through a 10–25 basis-point core — consistent with the expected-loss levels embedded in NAIC risk-based-capital factors for loans of this profile — to roughly 40 basis points for the most volatile sector (full-service hotels)."),

  h1("2. What Questions the Model Answers"),
  bullet("Which property sectors offer the best risk-adjusted returns at today’s pricing — not just the highest projected IRR?"),
  bullet("How much downside does each sector carry? What is the probability of underperforming a hurdle rate, and how bad is a bad outcome?"),
  bullet("For lending: is the market spread on each sector adequate compensation for expected credit losses? Which sectors offer the widest loss-adjusted spread?"),
  bullet("How do sectors rank on credit quality when default probability and loss severity are considered together over a full ten-year hold?"),
  bullet("How sensitive are these answers to the underlying assumptions — and do the simulated outcomes stay faithful to the inputs we gave the model? (A built-in calibration report verifies this every run.)"),

  h1("3. Inputs"),
  p("The model reads two input workbooks, both designed to be refreshed regularly without touching the model code:"),
  h2("3.1 Sector assumptions (TESTDCF8)"),
  p("One row per property sector, describing a representative stabilized asset normalized to a purchase price of 100. For each sector, the file provides:"),
  bullet("Starting revenue, operating expenses, and capital-expenditure load;"),
  bullet("Expected ten-year growth rates for revenue and expenses;"),
  bullet("A going-in cap rate and the expected change in cap rate over the hold (the “cap-rate spread”);"),
  bullet("For each of these drivers, a volatility (how widely outcomes vary year to year) and a skew (whether surprises lean to the downside or upside)."),
  p("The volatility and skew columns are what make the model stochastic rather than deterministic — they encode, for example, that hotel revenue swings much harder than manufactured-housing revenue, and that revenue surprises in most sectors lean to the downside."),
  p("One convention matters for interpreting every output: these are single-asset volatilities, not index volatilities. A property index is effectively a portfolio of thousands of assets — idiosyncratic events cancel across holdings and appraisal smoothing dampens what remains — so index volatility understates the risk of owning one building. The model deliberately prices one representative asset per sector (one deal on the equity side, one loan on the credit side), so its inputs sit well above index-level volatilities by design, and its risk metrics describe standalone assets rather than diversified portfolios. Inputs should accordingly be validated against property-level data, not index series."),
  h2("3.2 Debt terms (DEBTTERMS)"),
  p("One row per sector with current market financing terms for a senior mortgage: credit spread over SOFR (in basis points), loan-to-value ratio, and debt yield. These reflect where a stabilized asset in each sector could be financed today and are the bridge from the property simulation to the credit analysis."),
  p("Because both files are refreshed on a regular cycle, the model always prices risk off current assumptions; the machinery described below does not change when the inputs do.")
);

// ================= 4. SIMULATION =================
children.push(
  h1("4. How the Simulation Works"),
  p("For each sector the model builds 10,000 independent ten-year scenarios. Each scenario is a complete, internally consistent pro forma. Four design features matter most for interpreting the results:"),
  h2("4.1 Realistic randomness, not bell curves"),
  p("Annual revenue and expense growth are drawn from skewed distributions calibrated to the input volatility and skew — so a sector whose bad years are worse than its good years are good is modeled that way, rather than forced into a symmetric bell curve. Revenue and expense growth are drawn together with a sector-specific correlation, set from evidence on each sector’s cost structure: hotels highest (0.75–0.85 — industry flow-through data shows expenses absorb 40–70% of a revenue change in the same year), triple-net and reimbursement-heavy sectors high when measured gross of recoveries (0.65–0.75), office and apartments moderate (0.45 — the one directly measured statistic in the literature), and tax/insurance-dominated residential and storage sectors low (0.30–0.35, since their expenses grind upward largely independent of revenue). This correlation matters more than it looks: through operating leverage it controls how hard net operating income swings when revenue moves."),
  h2("4.2 Shocks fade rather than compound forever"),
  p("A bad year is not a permanent re-basing of the asset’s earning power. Each sector’s revenue path is pulled back toward its long-run trend, with roughly half of any deviation closed in about two and a half years. This mirrors observed behavior — hotel revenues, for example, fall hard in recessions but recover — and it prevents the model from overstating long-horizon risk in volatile sectors. Without this feature, a hotel that had one bad year in 2027 would be assumed to stay proportionally impaired through 2035, which is not how operating real estate behaves."),
  p("Expenses revert to their trend as well, but more slowly (half of a deviation closes in about seven years): operating costs track inflation over the long run, but they are sticky — they do not adjust as quickly as revenue recovers. That gap is deliberate, and it is what allows sustained expense pressure against weak revenue to remain a genuine risk in the simulation."),
  h2("4.3 Growth assumptions are honored on average"),
  p("Random compounding has a subtle bias: if you draw growth rates that average 3%, the compounded result averages less than 3% growth per year (volatility drags on compounding). The model corrects for this explicitly, solving for the draw distribution that makes the simulated ten-year growth match the input assumption on average. Every run produces a calibration report comparing realized simulated growth, cap rates, and capex against the inputs; agreement is currently within a few hundredths of a percent."),
  h2("4.4 Cap rates follow the house view, plus noise"),
  p("The cap-rate path glides linearly from the going-in cap rate to the assumed terminal cap rate over the hold, exactly matching the deterministic base case on average. Around that glide path, each scenario adds mean-reverting random noise — so individual futures see cap rates overshoot and recover, but the center of the distribution stays on the house view. Later years of the hold also pin revenue growth near a long-run 3% with tightening uncertainty, reflecting that a stabilized asset’s terminal-year assumptions should not be wild."),
  h2("4.5 From scenario to return"),
  p("Each scenario produces ten years of net cash flow (net operating income less capital expenditures) plus a sale at the end of year ten, valued by applying the scenario’s year-ten cap rate to year-eleven forward NOI. Exit value is floored at 30% of the purchase price — a deliberate, conservative-recovery assumption discussed in Section 8. The ten-year unlevered IRR of that cash-flow stream is the scenario’s headline return. Note this is an asset-level (unlevered) return: it measures the property, not a leveraged equity position.")
);

// ================= 5. EQUITY OUTPUTS =================
children.push(
  h1("5. Equity Outputs"),
  bulletBold("Return distribution. ", "The full histogram of 10,000 IRRs per sector: mean, spread, best and worst outcomes, and smooth density curves for visual comparison across sectors."),
  bulletBold("Risk-adjusted ratios. ", "A Sharpe-style ratio (mean IRR over the risk-free rate, per unit of outcome dispersion) and a Sortino-style ratio (mean IRR over a 7% minimum acceptable return, per unit of downside dispersion). One caveat for the technically minded: these are cross-scenario outcome ratios, not time-series ratios, so they should be compared across sectors within the model rather than against published market Sharpe ratios."),
  bulletBold("Annual return profile. ", "NCREIF-style total returns (income plus appreciation, net of capex) by hold year, with three- and five-year compound averages — useful for comparing the model’s trajectory against benchmark history."),
  bulletBold("Base-case pro formas. ", "A deterministic DCF and loan pro forma using the raw assumption means, so users can always see the “no randomness” anchor beneath the distribution."),
  bulletBold("Scenario drill-down. ", "Any individual scenario can be opened as a full year-by-year DCF, showing exactly which growth draws and cap-rate path produced its IRR. Nothing in the model is a black box at the scenario level."),
  bulletBold("Calibration report. ", "Input-versus-realized comparison for growth, capex, and exit cap rates, confirming each run that the simulation is faithful to its assumptions.")
);

// ================= 6. CREDIT =================
children.push(
  h1("6. Credit Model"),
  p("The credit module answers: if a senior mortgage were made against this asset at today’s market terms, what credit losses should the lender expect? It reuses the same 10,000 property scenarios — so credit risk and equity risk are measured on identical futures — and follows the architecture of Moody’s Commercial Mortgage Metrics (CMM) framework: default probability driven by debt-service coverage, loss severity driven by collateral value."),
  h2("6.1 The loan"),
  p("Each sector’s loan is sized at the input loan-to-value ratio and priced at SOFR plus the input market spread, interest-only — typical of institutional senior mortgages on stabilized assets."),
  h2("6.2 Default during the term"),
  p("In every scenario and every hold year, the model computes the property’s debt-service coverage ratio (DSCR — cash flow relative to the interest bill) and its mark-to-market loan-to-value (the loan against what the property would fetch that year). These two measures feed an annual default probability: a loan comfortably covering its debt service on a property worth well above the loan almost never defaults; a loan under water on both measures defaults with high probability. Defaults are then drawn year by year — so a loan that struggles in years two and three can default then, at a depressed property value, rather than the model only checking at maturity. Term default is deliberately probabilistic rather than automatic: an underwater borrower who is still covering debt service usually keeps paying, and the model reflects that."),
  p("Two floors keep the model honest at the safe end. First, annual default probability never falls below 0.6% per year, no matter how strong coverage looks — history shows performing, well-covered commercial mortgages still default for idiosyncratic reasons (tenant bankruptcy, fraud, environmental events) that coverage ratios cannot see, and interest-only loans carry no amortization cushion. Second, loss severity given default never falls below 15% — even a well-collateralized workout incurs legal, servicing, and disposition costs."),
  h2("6.3 Default at maturity"),
  p("Surviving the ten hold years is not enough: at maturity the balloon comes due, and repayment stops being optional. Every scenario that reaches year ten without a term default faces a value test based on its mark-to-market loan-to-value at exit. Below 75% — the leverage a take-out lender will actually provide — the balloon refinances comfortably and the loan repays in full. Above 105% — the property worth less than the loan by more than any sponsor would bridge — the loan always defaults. Between those two points sits the refinancing gap: the property has positive equity on paper, but a take-out lender will only size a new loan to roughly 70–75% of value, leaving a hole the sponsor must fill. Default probability rises smoothly across that zone (a loan exiting at 90% LTV defaults about half the time). Historically, this refinancing-gap channel — not outright negative equity — is where most commercial mortgage defaults occur."),
  p("Of the loans that default at maturity, 20% are assumed to cure — resolve through extension or workout with no principal loss, as values recover — consistent with rating-agency evidence that many defaults at moderate leverage ultimately repay (KBRA’s single-borrower study shows blended loss severity of ~11% across all resolved defaults, versus ~40% conditional on a meaningful loss). Cured loans count as defaults with zero loss, so reported default rates are comparable to published default studies and reported severity is a blended figure."),
  h2("6.4 Loss given default"),
  p("When a scenario defaults, recovery equals the property’s mark-to-market value in the default year, reduced by workout costs: ongoing carry (servicing, legal, maintenance, taxes and insurance) over an assumed workout period, one-time disposition costs (broker commission, renovation), and interest foregone during the workout. Workout periods and severities differ by property class — hotels resolve faster and with lower severity than the historical average, traditional office slower and with higher severity — consistent with rating-agency workout data."),
  h2("6.5 Expected loss and ratings"),
  p("Probability of default multiplied by loss severity gives total expected loss over the ten-year hold, which is converted to an annual rate (the constant yearly loss that compounds to the ten-year total) and expressed in basis points. That annual expected loss is compared to the market credit spread — producing a loss-adjusted spread, the model’s core relative-value measure for lending — and mapped to a Moody’s-style letter grade:"),
  makeTable(
    ["Annual expected loss", "Indicative grade"],
    [
      ["≤ 1 bp", "Aaa"],
      ["≤ 4 bps", "Aa"],
      ["≤ 10 bps", "A"],
      ["≤ 25 bps", "Baa"],
      ["≤ 75 bps", "Ba"],
      ["≤ 250 bps", "B"],
      ["> 250 bps", "Caa–C"],
    ],
    [0.5, 0.5]
  ),
  p("", { para: { spacing: { after: 120 } } }),
  h2("6.6 Calibration to historical experience"),
  p("In July 2026 the default-probability and severity parameters were recalibrated against published U.S. commercial-mortgage loss history: Fitch’s conduit CMBS default study (1993–2002), KBRA’s single-borrower CMBS study (1993–2024), Moody’s CMBS loss-severity reports, NAIC risk-based-capital factors, and the Esaki–Snyderman life-company default studies. Those sources consistently show:"),
  bullet("Stabilized, moderately leveraged institutional senior mortgages lose roughly 5–15 basis points per year through the cycle;"),
  bullet("Hotels default five to ten times more often than the most stable sectors, with severities of 45% or more, implying 40–60+ basis points of annual expected loss;"),
  bullet("Self-storage, industrial, and stabilized multifamily sit consistently at the low end; hotels and operating-intensive sectors at the high end."),
  p("The model’s current output spans roughly 8 to 40 basis points per year across the 21 sectors, with a 10–25 basis-point core, with an ordering that matches this historical record — hotels and cold storage at the top, driven largely by the maturity test (they are the sectors most likely to be worth less than the loan at exit), and medical office, manufactured housing, net-lease, and stabilized housing at the bottom. The calibration procedure scores candidate parameters on both the level of the ladder and its ordering against the historical record, and the script is retained alongside the model so parameters can be re-tuned quickly whenever inputs are refreshed or new loss data becomes available.")
);

// ================= 7 & 8 =================
children.push(
  h1("7. What Makes This Model Different From a Spreadsheet Pro Forma"),
  bulletBold("Distributions, not point estimates. ", "Every output is a range with probabilities attached. “Mean IRR of 7.4%” comes with “and a 20% chance of falling below 5%.”"),
  bulletBold("Consistent equity and credit views. ", "The same 10,000 futures drive both the IRR distribution and the credit losses, so a sector’s equity risk and credit risk can be compared apples-to-apples."),
  bulletBold("Assumption fidelity is verified, not assumed. ", "The calibration report proves each run that simulated averages match the inputs."),
  bulletBold("Full transparency at the scenario level. ", "Any of the 10,000 scenarios can be opened as an ordinary year-by-year DCF."),

  h1("8. Key Assumptions and Limitations"),
  p("Every model simplifies. The material simplifications here, and their direction of bias, are:"),
  bulletBold("Returns are unlevered. ", "The IRR distribution measures the asset, not a leveraged equity position. Leverage would widen every distribution and lower risk-adjusted ratios. A levered equity view is a natural future extension — the debt terms are already in the model."),
  bulletBold("Exit value is floored at 30% of purchase price. ", "This truncates the most extreme left-tail outcomes on both the equity and credit sides. It is a deliberate assumption that land-plus-recovery value puts a floor under institutional assets, but users should know the very worst simulated outcomes are shaped by it."),
  bulletBold("The loan is interest-only with a value-based maturity test. ", "There is no amortization benefit. Maturity risk is captured by the exit LTV > 105% test rather than a full refinancing-market model — so a scenario where lending standards tighten sharply while values hold up would not register as maturity stress."),
  bulletBold("Sector risk rankings inherit the input volatilities. ", "If an input volatility is out of line with history (for example, a stable sector given a high volatility), the model will faithfully rank it as riskier. The regular input-refresh process, not the model, is the control for this."),
  bulletBold("No recession scenario. ", "Each simulated future draws its shocks independently around trend — there is no correlated downturn in which revenue falls, cap rates spike, refinancing tightens, and expense flexibility breaks down all at once, across sectors. This most affects the sectors whose historical losses were concentrated in such episodes: full-service hotels, for example, price below their long-run historical loss experience for exactly this reason. A systematic stress factor is the planned remedy."),
  bulletBold("One representative asset per sector. ", "The model prices a stabilized, sector-typical asset at market financing terms. It is a sector-comparison and relative-value tool, not an underwriting model for a specific building."),
  bulletBold("Simulation noise. ", "With 10,000 scenarios, headline statistics are stable, but small differences between similar sectors (a basis point or two of expected loss) are within sampling noise and should not be over-read."),

  h1("9. Governance and Refresh Cycle"),
  bulletBold("Inputs. ", "The two input workbooks are refreshed on a regular cycle by the Research & Strategy team; the model re-prices automatically from whatever inputs it is given. A dedicated input-production process is planned."),
  bulletBold("Reproducibility. ", "All randomness is seeded: the same inputs always produce the same 10,000 scenarios and the same outputs, so results are audit-stable between refreshes."),
  bulletBold("Recalibration. ", "The credit parameters are held fixed between recalibrations. The calibration tooling is preserved with the model so the historical-anchor exercise (Section 6.6) can be repeated as new loss data is published or when input refreshes materially change the simulated paths."),
  bulletBold("Validation. ", "Each run self-checks: the calibration report (inputs versus realized) and the base-case pro formas provide the deterministic anchors against which the simulation can always be verified.")
);

// ================= APPENDICES =================
children.push(
  new Paragraph({ children: [new PageBreak()] }),
  h1("Appendix A. Technical Parameters (Current Values)"),
  p("For the technically inclined reader; none of the following is required to interpret the outputs."),
  makeTable(
    ["Parameter", "Value", "Role"],
    [
      ["Scenarios per sector", "10,000", "Monte Carlo sample size"],
      ["Hold period", "10 years (11-year pro forma; year 11 is valuation-only forward NOI)", "Investment horizon"],
      ["Growth distributions", "Skew-normal, per-sector mean/volatility/skew", "Revenue, expense, capex, cap-spread draws"],
      ["Revenue–expense correlation", "Per-sector input, 0.20–0.85 (Gaussian copula); from lease-structure and hotel flow-through evidence", "Joint behavior of growth draws; verified against realized correlation each run"],
      ["Revenue mean reversion", "0.25 per year (half-life ≈ 2.4 years)", "Pulls revenue back to trend after shocks"],
      ["Expense mean reversion", "0.10 per year (half-life ≈ 7 years) — costs are stickier than revenue", "Pulls expenses back to inflation trend"],
      ["Terminal revenue growth", "3.0% pinned over final 4 growth years, fading volatility", "Stabilizes exit-year assumptions"],
      ["CAGR consistency", "Drift solved so expected log growth matches input CAGR (Jensen correction)", "Keeps simulated averages faithful to inputs"],
      ["Cap-rate path", "Linear glide to terminal cap + mean-reverting noise (speed 0.25)", "Centered on base case by construction"],
      ["Exit valuation", "Year-11 forward NOI ÷ year-10 cap rate; floor 30% of cost; cap-rate floor 3%", "Sale proceeds"],
      ["Base SOFR", "3.63%", "Loan coupon = SOFR + sector spread"],
      ["Term default model", "Logistic annual EDF in DSCR distress/safety and mark-to-market LTV; intercept −6.0, distress +2.0, safety −1.31, LTV +1.5", "Annual default probability, years 1–10"],
      ["Default probability floor", "0.6% per year", "Idiosyncratic event risk (IO loans, no amortization cushion)"],
      ["Maturity default test", "Refinancing-gap ramp on exit mark-to-market LTV: P=0 below 75%, rising linearly to P=1 at 105%", "Balloon repayment / refi-gap risk"],
      ["Maturity cure rate", "20% of maturity defaults resolve with no principal loss", "Extensions / workouts (KBRA evidence)"],
      ["Severity floor", "15% of loan", "Minimum workout cost"],
      ["Workout costs", "5.7%/yr carry + 5.5% one-time; workout 1.5 yrs (hotel), 2.5 yrs (office), 2.0 yrs (other)", "Loss given default"],
      ["Severity scalars", "Hotel 0.70×, traditional office 1.40×", "Property-class severity adjustment"],
      ["EL annualization", "Constant annual rate compounding to the 10-year total", "Basis-point expected loss"],
      ["Risk-free rate / hurdle", "4.25% / 7.00%", "Sharpe- and Sortino-style ratios"],
    ],
    [0.28, 0.42, 0.30]
  ),
  p("", { para: { spacing: { after: 120 } } }),

  h1("Appendix B. Glossary"),
  makeTable(
    ["Term", "Meaning"],
    [
      ["Cap rate", "A property’s net operating income divided by its value; the real estate equivalent of an earnings yield. Higher cap rate = lower price per dollar of income."],
      ["CapEx", "Capital expenditures — spending on the building itself, modeled as a fraction of NOI."],
      ["DSCR", "Debt-service coverage ratio: property cash flow divided by the loan’s interest bill. Below 1.0, the property does not cover its debt service."],
      ["EDF", "Expected default frequency — the probability a loan defaults in a given year."],
      ["Expected loss (EL)", "Probability of default multiplied by loss severity; the actuarial cost of credit risk, quoted here in basis points per year."],
      ["IRR", "Internal rate of return — the annualized return implied by the full stream of cash flows including purchase and sale."],
      ["LGD / severity", "Loss given default — the share of the loan balance lost after recovering and disposing of the collateral."],
      ["LTV", "Loan-to-value ratio. “Mark-to-market LTV” re-measures it each year against the simulated property value."],
      ["Loss-adjusted spread", "The market credit spread minus annual expected loss — what the lender keeps after expected credit costs."],
      ["Mean reversion", "The tendency of a variable to return toward its long-run trend after a shock."],
      ["Monte Carlo simulation", "Generating thousands of random but realistic scenarios and reading risk from the distribution of outcomes."],
      ["NOI", "Net operating income — revenue minus operating expenses, before debt service and capex."],
      ["Skew", "Asymmetry in a distribution: negative skew means bad surprises are bigger than good ones."],
      ["SOFR", "Secured Overnight Financing Rate — the floating-rate benchmark for the modeled loans."],
      ["Sortino ratio", "Return over a hurdle divided by downside-only dispersion; like Sharpe but only penalizing bad volatility."],
    ],
    [0.25, 0.75]
  )
);

const doc = new Document({
  numbering: {
    config: [
      {
        reference: "bullets",
        levels: [
          {
            level: 0,
            format: LevelFormat.BULLET,
            text: "•",
            alignment: AlignmentType.LEFT,
            style: { paragraph: { indent: { left: 480, hanging: 240 } } },
          },
        ],
      },
    ],
  },
  styles: {
    default: {
      document: { run: { font: "Calibri", size: 22 } },
    },
  },
  sections: [
    {
      properties: {
        page: {
          size: { width: 12240, height: 15840 },
          margin: {
            top: convertInchesToTwip(1),
            bottom: convertInchesToTwip(1),
            left: convertInchesToTwip(1),
            right: convertInchesToTwip(1),
          },
        },
      },
      children,
    },
  ],
});

Packer.toBuffer(doc).then((buf) => {
  fs.writeFileSync(process.argv[2], buf);
  console.log("written:", process.argv[2]);
});
