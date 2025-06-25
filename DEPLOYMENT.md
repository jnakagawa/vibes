# Deployment Guide

This AR Toy collection uses a universal file discovery system that works on **any static hosting platform**.

## 🌐 How It Works

### Universal Compatibility
- **GitHub Pages** ✅ 
- **Netlify** ✅
- **Vercel** ✅  
- **Local development** ✅
- **Any static host** ✅

### File Discovery System
1. **Static JSON**: `files.json` contains pre-generated file listings
2. **Build script**: `npm run build` scans directories and updates the JSON
3. **Auto-fallback**: If JSON fails, falls back to pattern-based discovery
4. **GitHub Actions**: Auto-updates file list on every push

## 🚀 Deployment Steps

### GitHub Pages
```bash
# Files are auto-discovered via GitHub Actions
# Just push your code - GitHub Actions handles the rest
git add .
git commit -m "Add new synth"
git push
```

### Netlify
```bash
# Set build command in netlify.toml or dashboard:
npm run build

# Or manual deploy:
npm run build
# Then drag & drop the built files
```

### Vercel
```bash
# Set build command in vercel.json:
npm run build

# Or use CLI:
npm run build
vercel --prod
```

### Local Development
```bash
# Generate file list and serve
npm run dev

# Or manually:
npm run build
npm run serve
```

## 🔧 Adding New Files

### Automatic (Recommended)
1. Add your new `.html` synth file
2. Commit and push to GitHub
3. GitHub Actions automatically updates `files.json`
4. Your file appears in the browser

### Manual
```bash
# If working locally or on other platforms
npm run build
git add files.json
git commit -m "Update file list"
```

## 📁 File Structure

```
ar-toy/
├── files.json              # Auto-generated file listings
├── index.html              # Main file browser
├── scripts/
│   └── generate-file-list.js  # File discovery script
├── .github/workflows/
│   └── build.yml           # Auto-update workflow
├── vibes/                  # Synth collection
│   ├── *.html             # Individual synths
│   └── ...
└── package.json           # Build scripts
```

## 🛠️ Customization

### Adding New Directories
Edit `scripts/generate-file-list.js`:
```javascript
const directories = {
  root: '.',
  vibes: './vibes',
  newdir: './new-directory'  // Add this
};
```

### Excluding Files
Add patterns to exclude in `scripts/generate-file-list.js`:
```javascript
const excludePatterns = [
  /^\./, 
  /^node_modules$/,
  /^your-pattern$/  // Add this
];
```

## 🔍 Debug Information

The browser console shows detailed logs:
- `🔍 Loading files from files.json...` - Primary method
- `🔄 Falling back to pattern-based discovery...` - Fallback active
- `📁 Files loaded:` - Successful file discovery
- `❌ File discovery failed:` - Complete failure

## 🎯 Benefits

- **Zero maintenance**: Add files → they appear automatically
- **Universal hosting**: Works on any static platform
- **Graceful fallback**: Never breaks completely
- **GitHub integration**: Auto-updates via Actions
- **Local development**: Full functionality offline

---

*This system eliminates the need for server-side APIs or platform-specific functions while maintaining full auto-discovery capabilities.* 