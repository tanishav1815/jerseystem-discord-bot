const { default: axios } = require('axios');
const fs = require('fs');

async function testFetch() {
    const sheetIdsEnv = "1zAPoVOSsVHe4svVcUOwE_PV7Ykukk8H-94pMDt5zCDg|0, 1zAPoVOSsVHe4svVcUOwE_PV7Ykukk8H-94pMDt5zCDg|2099380006, 1zAPoVOSsVHe4svVcUOwE_PV7Ykukk8H-94pMDt5zCDg|69944674, 1zAPoVOSsVHe4svVcUOwE_PV7Ykukk8H-94pMDt5zCDg|1072111664, 1zAPoVOSsVHe4svVcUOwE_PV7Ykukk8H-94pMDt5zCDg|103041255";
    const sheetIds = sheetIdsEnv.split(',').map(id => id.trim()).filter(id => id.length > 0);
    let combinedDocText = "";
    for (const sheetEntry of sheetIds) {
        try {
            let sheetId = sheetEntry;
            let gid = '0';
            if (sheetEntry.includes('|')) {
                [sheetId, gid] = sheetEntry.split('|');
            }
            const sheetUrl = `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv&gid=${gid}`;
            const response = await axios.get(sheetUrl, {
                maxRedirects: 5,
                responseType: 'text'
            });
            combinedDocText += `--- Google Sheet: ${sheetId} (GID: ${gid}) ---\n${response.data}\n\n`;
        } catch (err) {
            combinedDocText += `--- ERROR FETCHING GID ${sheetEntry}: ${err.message} ---\n\n`;
        }
    }
    fs.writeFileSync('./fetch_output.txt', combinedDocText);
    console.log("Done");
}
testFetch();
