# Configuration Guide

## Split Configuration System

Jakaraoke uses a split configuration system to separate shared settings from machine-specific paths.

### Files

- **`config.json`** (committed to git)
  - Shared settings: port, library names, active library
  - Library paths are set to `null` for those requiring local overrides

- **`config.local.json`** (gitignored, machine-specific)
  - Contains actual file paths for song libraries
  - Overrides paths in `config.json`
  - Not committed to git - each machine has its own

- **`config.local.example.json`** (committed to git)
  - Template for creating your `config.local.json`
  - Shows the expected structure

### Setting Up on a New Machine

1. Copy the example file:
   ```bash
   cp config.local.example.json config.local.json
   ```

2. Edit `config.local.json` and update paths to match your machine:
   ```json
   {
     "libraries": [
       {
         "name": "WingPunch",
         "path": "/path/on/your/machine/Song_Repo/WingPunchDB"
       },
       {
         "name": "SoloSet",
         "path": "/path/on/your/machine/Song_Repo/SoloSetDB"
       }
     ]
   }
   ```

3. Start the server - it will automatically merge the configs

### How It Works

When the server starts:
1. Loads `config.json` (shared settings)
2. If `config.local.json` exists, loads it
3. Merges library paths from local config into base config
4. Uses the merged configuration

### Benefits

✅ Shared settings (port, library names) sync via git  
✅ Machine-specific paths stay local  
✅ Easy to add new shared settings - just update `config.json`  
✅ No merge conflicts on paths  
✅ Simple setup on new machines  

### Adding a New Library

To add a new library that all machines should know about:

1. Add it to `config.json` with `path: null`
2. Each machine adds the actual path to their `config.local.json`
3. Commit and push `config.json`
4. Other machines pull and update their `config.local.json`
