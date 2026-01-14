import sys, string, warnings, nltk, joblib, json, os
from nltk.corpus import stopwords

warnings.filterwarnings("ignore")
nltk.download('stopwords', quiet=True)

def text_process(review):
    nopunc = [char for char in review if char not in string.punctuation]
    nopunc = ''.join(nopunc)
    return [word for word in nopunc.split() if word.lower() not in stopwords.words('english')]

# Load trained pipeline from absolute path
current_dir = os.path.dirname(os.path.abspath(__file__))
model_path = os.path.join(current_dir, "model.joblib")
model = joblib.load(model_path)

def predict_reviews(reviews):
    results = []
    for review in reviews:
        pred = model.predict([review])[0]
        prob = model.predict_proba([review])[0].tolist()
        results.append({"review": review, "prediction": pred, "probability": prob})
    return results

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python predict.py '[\"review 1\", \"review 2\"]'")
        sys.exit(1)

    # Parse the JSON list of reviews
    try:
        sys.argv[1] = sys.argv[1][2:-2]
        reviews = sys.argv[1].split(",")
        if not isinstance(reviews, list):
            raise ValueError
    except:
        print("Invalid input. Provide a JSON list of review strings.")
        sys.exit(1)

    results = predict_reviews(reviews)
    print(json.dumps(results))