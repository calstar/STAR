# Quick Reference: Working with Separate Repositories

## Branch Setup ✅

Two separate branches have been created and pushed:

1. **`engine-only`** → `engine-design` remote (Engine Design repo)
2. **`parachute-only`** → `parachute-dynamics` remote (Parachute Dynamics repo)

## Daily Workflow

### Working on Engine Design

```bash
# Switch to engine branch
git checkout engine-only

# Make your changes to pintle_models/, pintle_pipeline/, examples/pintle_engine/
# ... edit files ...

# Commit and push
git add .
git commit -m "Your commit message"
git push engine-design engine-only
```

### Working on Parachute Dynamics

```bash
# Switch to parachute branch
git checkout parachute-only

# Make your changes to parachute/, examples/parachute/
# ... edit files ...

# Commit and push
git add .
git commit -m "Your commit message"
git push parachute-dynamics parachute-only
```

## Repository URLs

- **Engine Design**: `git@github.com:KushMahajan/EngineDesign.git`
- **Parachute Dynamics**: `git@github.com:KushMahajan/Parachute-Dynamics.git`

## Branch Status

- ✅ `engine-only` - Contains only engine files (pintle_models/, pintle_pipeline/, examples/pintle_engine/)
- ✅ `parachute-only` - Contains only parachute files (parachute/, examples/parachute/)
- `pintle-only` - Contains both (kept for reference, but use the specific branches above)

## What's in Each Branch

### engine-only branch:
- ✅ `pintle_models/` - Core engine models
- ✅ `pintle_pipeline/` - Pipeline infrastructure  
- ✅ `examples/pintle_engine/` - Engine examples
- ✅ `README.md` - Engine documentation
- ✅ `.gitignore` - Engine-specific ignore rules
- ❌ No parachute files

### parachute-only branch:
- ✅ `parachute/` - Parachute simulation engine
- ✅ `examples/parachute/` - Parachute examples
- ✅ `README_PARACHUTE.md` - Parachute documentation
- ✅ `.gitignore` - Parachute-specific ignore rules
- ❌ No engine files

## Tips

1. **Always check which branch you're on** before making changes:
   ```bash
   git branch --show-current
   ```

2. **If you accidentally make changes on the wrong branch**, you can:
   - Stash them: `git stash`
   - Switch branches: `git checkout <correct-branch>`
   - Apply stash: `git stash pop`

3. **To see what files are in each branch**:
   ```bash
   git checkout engine-only
   ls  # See engine files
   
   git checkout parachute-only
   ls  # See parachute files
   ```

## Next Steps

You can now:
1. Set `engine-only` as the default branch in the Engine Design repo
2. Set `parachute-only` as the default branch in the Parachute Dynamics repo
3. Start working on each project independently!

