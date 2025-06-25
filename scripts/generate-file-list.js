#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

// Directories to scan
const directories = {
  root: '.',
  vibes: './vibes'
};

// Files to exclude
const excludePatterns = [
  /^\./,                    // Hidden files
  /^node_modules$/,         // Node modules
  /^scripts$/,              // Scripts directory
  /^netlify$/,              // Netlify directory
  /^\.git$/,                // Git directory
  /^files\.json$/,          // The output file itself
];

function shouldExcludeFile(filename) {
  return excludePatterns.some(pattern => pattern.test(filename));
}

function scanDirectory(dirPath) {
  try {
    if (!fs.existsSync(dirPath)) {
      console.log(`📂 Directory ${dirPath} doesn't exist, skipping...`);
      return [];
    }

    console.log(`📁 Scanning ${dirPath}...`);
    
    return fs.readdirSync(dirPath)
      .filter(file => !shouldExcludeFile(file))
      .map(file => {
        const filePath = path.join(dirPath, file);
        const stats = fs.statSync(filePath);
        
        // Only include actual files, not subdirectories (except vibes)
        if (stats.isDirectory() && file !== 'vibes') {
          return null;
        }
        
        return {
          name: file,
          isDirectory: stats.isDirectory(),
          size: stats.size,
          modified: stats.mtime.toISOString(),
          extension: path.extname(file).toLowerCase()
        };
      })
      .filter(Boolean); // Remove null entries
      
  } catch (error) {
    console.error(`❌ Error scanning ${dirPath}:`, error.message);
    return [];
  }
}

function generateFileList() {
  console.log('🔍 Generating file list...');
  
  const result = {};
  
  // Scan each directory
  for (const [dirName, dirPath] of Object.entries(directories)) {
    result[dirName] = scanDirectory(dirPath);
    console.log(`   Found ${result[dirName].length} files in ${dirName}/`);
  }
  
  // Write to files.json
  const outputPath = 'files.json';
  const jsonContent = JSON.stringify(result, null, 2);
  
  fs.writeFileSync(outputPath, jsonContent);
  console.log(`✅ Generated ${outputPath} with file listings`);
  console.log(`📊 Total files: ${Object.values(result).flat().length}`);
  
  // Show summary
  console.log('\n📋 Summary:');
  for (const [dirName, files] of Object.entries(result)) {
    const htmlFiles = files.filter(f => f.name.endsWith('.html'));
    console.log(`   ${dirName}/: ${files.length} files (${htmlFiles.length} synths)`);
  }
}

// Run the generator
if (require.main === module) {
  generateFileList();
}

module.exports = { generateFileList }; 