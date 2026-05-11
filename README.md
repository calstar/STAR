# STAR                                                        
                                                                
  WIP: still centralizing some of the software and dividing the calibration code from the server code.                        
                                                                
  - Setup: COMING SOON                                          
  - Documentation: https://calstar.github.io/STAR/            

  Drop that straight into the GitHub editor if it matches your  intent — happy to tweak wording.                              
                                                                
  Proposed order for your six items (going low-risk → high-risk, so each later step lands on a stable base):                
                                                                
  1. Fix/clean the doc automation (item 3) — finish what we just started; verify the workflow turns green end-to-end and Pages
   is serving.                                                  
  2. CI standards + formatting checker (items 4 & 5 together) — these are one piece of work: lint/format workflows live       
  alongside the docs workflow and share the same patterns. Likely clang-format for firmware C++, ruff+black for Python,  
  pre-commit to tie them together.
  3. Audit submodules (item 6) — quick read-only sweep first (git submodule status, find . -name .gitmodules), then decide per-repo whether to convert to subtree, vendor, or fix. Doing this before the firmware reorg avoids churn.                  
  4. Centralized platformio.ini (item 2) — needs me to inventory every existing platformio.ini across the boards first;       
  biggest, most invasive change.
  5. Split calibration from server code (item 1) — architectural decision in daq-server; best done last so it doesn't collide with the other work.
