# Methodology document generator

`make_methodology.js` is the single source of truth for
`MIM_Stochastic_Model_Methodology.docx` (and its PDF copy) in the repo root.
**Edit the script, not the docx** — the document is regenerated wholesale.

## Regenerate

Requires Node.js.

```
cd docs
npm install          # first time only (installs the docx package)
node make_methodology.js "../MIM_Stochastic_Model_Methodology.docx"
```

To refresh the PDF, open the docx in Word and Save As PDF (or via PowerShell
COM automation: `Word.Application` → `Documents.Open` → `SaveAs2(..., 17)`).

## Keeping it honest

The document states current parameter values (Appendix A) and the current
expected-loss range. When model parameters change — especially anything in
`CREDIT_PARAMS` or the EDF coefficients in `sm_python.py` — update the
corresponding text here and regenerate, in the same commit as the model
change.
