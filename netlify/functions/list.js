const fs = require("fs");
const path = require("path");

exports.handler = async (event, context) => {
  try {
    // Define directories to scan
    const directories = {
      root: ".",
      vibes: "./vibes"
    };
    
    const result = {};
    
    // Scan each directory
    for (const [dirName, dirPath] of Object.entries(directories)) {
      try {
        // Check if directory exists
        if (fs.existsSync(dirPath)) {
          // Read directory contents
          const files = fs.readdirSync(dirPath)
            .filter(file => {
              // Filter out hidden files, node_modules, etc.
              if (file.startsWith('.')) return false;
              if (file === 'node_modules') return false;
              if (file === 'netlify') return false;
              
              // Get file stats
              const filePath = path.join(dirPath, file);
              const stats = fs.statSync(filePath);
              
              // Only include files (not directories) or specific directories we want
              return stats.isFile() || (stats.isDirectory() && file === 'vibes');
            })
            .map(file => {
              const filePath = path.join(dirPath, file);
              const stats = fs.statSync(filePath);
              
              return {
                name: file,
                isDirectory: stats.isDirectory(),
                size: stats.size,
                modified: stats.mtime.toISOString()
              };
            });
            
          result[dirName] = files;
        } else {
          result[dirName] = [];
        }
      } catch (err) {
        console.error(`Error reading directory ${dirPath}:`, err);
        result[dirName] = [];
      }
    }
    
    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*", // Enable CORS
      },
      body: JSON.stringify(result)
    };
    
  } catch (error) {
    console.error("Function error:", error);
    return {
      statusCode: 500,
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ error: "Failed to list files" })
    };
  }
}; 