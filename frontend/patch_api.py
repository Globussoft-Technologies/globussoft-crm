import glob
import re

files = glob.glob('src/pages/*.jsx')
for f in files:
    if f.endswith('Login.jsx'): continue
    with open(f, 'r') as file:
        content = file.read()
    
    if 'fetch(' in content:
        # Add import if missing
        if 'fetchApi' not in content:
            content = "import { fetchApi } from '../utils/api';\n" + content
            
        # Replace simple gets (e.g., fetch('http://localhost:5000/api/deals').then(res => res.json()).then(data => {)
        content = re.sub(
            r"fetch\(['`]http://localhost:5000(/api/[^'`]+)['`]\)\s*\n?\s*\.then\([\w\s]+=>\s*[\w\s]+\.json\(\)\)\s*\n?\s*\.then\(", 
            r"fetchApi('\g<1>').then(", 
            content
        )
        
        # Replace complex fetches without then (e.g., await fetch('http://localhost:5000/api/deals', { ... }))
        content = re.sub(
            r"fetch\(['`]http://localhost:5000(/api/[^'`]+)['`],", 
            r"fetchApi('\g<1>',", 
            content
        )
        
        # Replace complex fetches with then or templates (e.g., await fetch(`http://localhost:5000/api/deals/${id}`, { method: 'DELETE' }))
        content = re.sub(
            r"fetch\(`http://localhost:5000(/api/[^`]+)`", 
            r"fetchApi(`\g<1>`", 
            content
        )

        with open(f, 'w') as file:
            file.write(content)
