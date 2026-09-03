function addHttp(url) {
    // Check if the URL starts with 'localhost' and does not have 'http://' or 'https://'
    if (url.startsWith('localhost') && !url.startsWith('http://') && !url.startsWith('https://')) {
      return `http://${url}`;
    }
    // Return the original URL if it does not start with 'localhost' or already has 'http://' or 'https://'
    return url;
  }

  export default addHttp