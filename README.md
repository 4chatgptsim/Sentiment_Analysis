# Sentiment Analysis

A beginner-friendly Jupyter notebook that teaches sentiment analysis step by step: it trains a
model that reads a movie review and decides whether it is **positive** or **negative**.

The notebook explains every step in plain language before the code, and stays deliberately
simple: classic machine learning with scikit-learn, no deep learning and no GPU.

## What you will learn

- How a text-classification **pipeline** is put together, from raw text to predictions
- The classic NLP preprocessing techniques: **tokenization**, **stop-word removal**,
  **stemming**, **part-of-speech (POS) tagging**, **lemmatization** and **named entity
  recognition (NER)**, plus how to test whether they actually help
- How to turn text into numbers with **bag of words** and **TF-IDF**
- How to train and evaluate a **logistic regression** classifier
- How to read **accuracy, precision, recall, F1** and a **confusion matrix**
- How to look inside the model to see which words it relies on, and where it fails

## The pipeline

| Step | What happens | Tool |
|---|---|---|
| 1. Load | Download 2,000 labelled movie reviews (1,000 positive, 1,000 negative) | `nltk` |
| 2. Explore | Check class balance and review length | `pandas` |
| 3. Clean & preprocess | Lowercase and remove non-letters; demo of tokenization, stop words, stemming, POS tagging, lemmatization and NER | `re`, `nltk` |
| 4. Split | 80% for training, 20% held back for testing | `train_test_split` |
| 5. Vectorize | Turn each review into a TF-IDF vector (fit on training data only) | `TfidfVectorizer` |
| 6. Train | Learn a positive/negative weight for every word | `LogisticRegression` |
| 7. Evaluate | Score the model on reviews it has never seen | `sklearn.metrics` |
| 8. Interpret | Inspect the most important words and the mistakes | `model.coef_` |
| 9. Predict | Classify your own sentences | `predict_sentiment()` |
| 10. Pipeline | Rebuild steps 3, 5 and 6 as a single scikit-learn `Pipeline` | `make_pipeline` |
| 11. Experiment | Test whether stop-word removal, stemming or lemmatization improve the model | `nltk` |

## Results

On the 400 held-out test reviews the model gets **87.5% accuracy**, compared with 50% for
always guessing the same class.

| Preprocessing | Test accuracy |
|---|---|
| Basic cleaning only (used in the model) | 87.5% |
| + stop words removed | 87.0% |
| + stemming | 85.8% |
| + lemmatization | 85.5% |

On this dataset, none of the classic preprocessing steps gives a clear improvement. The
notebook explains why, and why removing stop words can even flip a sentence's meaning ("not
good" → "good").

The notebook also shows where this simple approach breaks down: short sentences, negation
("not good") and sarcasm.

## How to run it

You need a recent version of Python 3 (the notebook was tested with Python 3.13).

```bash
# 1. (optional) create and activate a virtual environment
python -m venv .venv
source .venv/bin/activate      # on Windows: .venv\Scripts\activate

# 2. install the dependencies
pip install -r requirements.txt

# 3. open the notebook
jupyter notebook sentiment_analysis.ipynb
```

Then run the cells from top to bottom with `Shift + Enter`. The first run downloads the dataset
(about 4 MB) and a few NLTK resources (tokenizer, stop words, tagger and so on), so you need
an internet connection. Running the whole notebook takes a minute or two.

The notebook is saved with its outputs, so you can also just read it on GitHub without
running anything.

## Dataset

The [NLTK movie reviews corpus](https://www.nltk.org/nltk_data/), also known as the
*Sentiment Polarity Dataset v2.0* by Bo Pang and Lillian Lee (Cornell, 2004). It contains
2,000 critics' reviews from the IMDb archive of the `rec.arts.movies.reviews` newsgroup. Each one
is labelled `pos` or `neg` based on the critic's own rating.

## Project structure

```
.
├── sentiment_analysis.ipynb   # the tutorial notebook
├── requirements.txt           # Python dependencies
└── README.md
```

## Next steps

The end of the notebook has exercises to try (raw counts, word pairs, other models) and pointers
to more advanced methods: lexicon-based sentiment (VADER), cross-validation, and transformer
models.

## Also in this repository

- [`snap-vanish/`](snap-vanish/): **Snap Vanish**, a Chrome extension that turns you into dust on
  Google Meet / Teams / Zoom when you snap your fingers. Install it from
  [`snap-vanish/dist/snap-vanish.zip`](snap-vanish/dist/snap-vanish.zip); see its
  [README](snap-vanish/README.md).
